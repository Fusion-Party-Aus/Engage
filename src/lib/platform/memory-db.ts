import type { Collection, Db, Document, Filter, FindOptions, ObjectId as MongoObjectId, UpdateFilter, UpdateOptions } from "mongodb";
import { ObjectId } from "mongodb";
import catalogueData from "../../data/policy-catalogue.json" with { type: "json" };
import initialRoundData from "../../data/initial-round.json" with { type: "json" };

type DocRecord = Record<string, any>;

function matchesCondition(value: any, condition: any): boolean {
  if (condition && typeof condition === "object" && !(condition instanceof Date) && !(condition instanceof ObjectId)) {
    for (const [op, target] of Object.entries(condition)) {
      if (op === "$in" && Array.isArray(target)) {
        if (!target.includes(value)) return false;
      } else if (op === "$ne") {
        if (value === target) return false;
      } else if (op === "$lte") {
        if (!(value <= (target as any))) return false;
      } else if (op === "$gte") {
        if (!(value >= (target as any))) return false;
      } else if (op === "$lt") {
        if (!(value < (target as any))) return false;
      } else if (op === "$gt") {
        if (!(value > (target as any))) return false;
      } else {
        return false;
      }
    }
    return true;
  }
  if (value instanceof Date && condition instanceof Date) {
    return value.getTime() === condition.getTime();
  }
  if (value instanceof ObjectId && condition instanceof ObjectId) {
    return value.toHexString() === condition.toHexString();
  }
  return value === condition;
}

function matchesFilter(doc: DocRecord, filter: DocRecord = {}): boolean {
  for (const [key, condition] of Object.entries(filter)) {
    if (!matchesCondition(doc[key], condition)) return false;
  }
  return true;
}

function applyProjection(doc: DocRecord, projection?: DocRecord): DocRecord {
  if (!projection) return structuredClone(doc);
  const entries = Object.entries(projection);
  const inclusions = entries.filter(([k, v]) => k !== "_id" && Boolean(v)).map(([k]) => k);
  if (inclusions.length > 0) {
    const out: DocRecord = {};
    if (projection._id !== 0 && "_id" in doc) out._id = doc._id;
    for (const key of inclusions) {
      if (key in doc) out[key] = structuredClone(doc[key]);
    }
    return out;
  }
  const out = structuredClone(doc);
  for (const [key, val] of entries) {
    if (!val) delete out[key];
  }
  return out;
}

function applyUpdate(target: DocRecord, update: DocRecord, isInsert: boolean): void {
  if (update.$set) {
    Object.assign(target, structuredClone(update.$set));
  }
  if (isInsert && update.$setOnInsert) {
    for (const [k, v] of Object.entries(update.$setOnInsert)) {
      if (!(k in target)) target[k] = structuredClone(v);
    }
  }
  if (update.$inc) {
    for (const [k, v] of Object.entries(update.$inc)) {
      target[k] = (typeof target[k] === "number" ? target[k] : 0) + Number(v);
    }
  }
  if (update.$addToSet) {
    for (const [k, v] of Object.entries(update.$addToSet)) {
      if (!Array.isArray(target[k])) target[k] = [];
      if (!target[k].includes(v)) target[k].push(v);
    }
  }
}

class InMemoryCursor<T> {
  private items: DocRecord[];
  private projection?: DocRecord;

  constructor(items: DocRecord[], projection?: DocRecord) {
    this.items = items;
    this.projection = projection;
  }

  project<P = T>(proj: DocRecord): InMemoryCursor<P> {
    this.projection = proj;
    return this as unknown as InMemoryCursor<P>;
  }

  sort(spec: Record<string, 1 | -1>): this {
    const entries = Object.entries(spec);
    this.items.sort((a, b) => {
      for (const [key, dir] of entries) {
        const av = a[key];
        const bv = b[key];
        if (av === bv) continue;
        if (av === undefined) return 1;
        if (bv === undefined) return -1;
        return (av < bv ? -1 : 1) * dir;
      }
      return 0;
    });
    return this;
  }

  limit(n: number): this {
    this.items = this.items.slice(0, n);
    return this;
  }

  async toArray(): Promise<T[]> {
    return this.items.map((item) => applyProjection(item, this.projection) as T);
  }
}

class InMemoryCollection<TSchema extends Document = Document> {
  private docs: DocRecord[] = [];
  private uniqueIndexes: string[][] = [];

  async createIndex(spec: Record<string, number>, options?: { unique?: boolean }): Promise<string> {
    if (options?.unique) {
      const keys = Object.keys(spec);
      if (!this.uniqueIndexes.some((u) => u.join(",") === keys.join(","))) {
        this.uniqueIndexes.push(keys);
      }
    }
    return "ok";
  }

  private checkUnique(candidate: DocRecord, ignoreDoc?: DocRecord): void {
    for (const keys of this.uniqueIndexes) {
      const clash = this.docs.find(
        (doc) => doc !== ignoreDoc && keys.every((k) => doc[k] !== undefined && doc[k] === candidate[k]),
      );
      if (clash) {
        const err = new Error("E11000 duplicate key error") as Error & { code: number };
        err.code = 11000;
        throw err;
      }
    }
  }

  find<T = TSchema>(filter: Filter<TSchema> = {}, options?: FindOptions): InMemoryCursor<T> {
    const matched = this.docs.filter((doc) => matchesFilter(doc, filter as DocRecord));
    return new InMemoryCursor<T>(matched, options?.projection as DocRecord | undefined);
  }

  async findOne<T = TSchema>(filter: Filter<TSchema> = {}, options?: FindOptions): Promise<T | null> {
    const found = this.docs.find((doc) => matchesFilter(doc, filter as DocRecord));
    if (!found) return null;
    return applyProjection(found, options?.projection as DocRecord | undefined) as T;
  }

  async insertOne(doc: DocRecord): Promise<{ insertedId: MongoObjectId }> {
    const copy = structuredClone(doc);
    if (!copy._id) copy._id = new ObjectId();
    this.checkUnique(copy);
    this.docs.push(copy);
    return { insertedId: copy._id };
  }

  async updateOne(filter: Filter<TSchema>, update: UpdateFilter<TSchema>, options?: UpdateOptions) {
    const existing = this.docs.find((doc) => matchesFilter(doc, filter as DocRecord));
    if (existing) {
      const candidate = structuredClone(existing);
      applyUpdate(candidate, update as DocRecord, false);
      this.checkUnique(candidate, existing);
      Object.assign(existing, candidate);
      return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0 };
    }
    if (options?.upsert) {
      const created: DocRecord = { _id: new ObjectId() };
      for (const [k, v] of Object.entries(filter as DocRecord)) {
        if (!v || typeof v !== "object" || v instanceof Date || v instanceof ObjectId) {
          created[k] = structuredClone(v);
        }
      }
      applyUpdate(created, update as DocRecord, true);
      this.checkUnique(created);
      this.docs.push(created);
      return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1, upsertedId: created._id };
    }
    return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
  }

  async updateMany(filter: Filter<TSchema>, update: UpdateFilter<TSchema>) {
    const matched = this.docs.filter((doc) => matchesFilter(doc, filter as DocRecord));
    for (const doc of matched) {
      applyUpdate(doc, update as DocRecord, false);
    }
    return { matchedCount: matched.length, modifiedCount: matched.length };
  }

  async deleteMany(filter: Filter<TSchema>) {
    const before = this.docs.length;
    this.docs = this.docs.filter((doc) => !matchesFilter(doc, filter as DocRecord));
    return { deletedCount: before - this.docs.length };
  }

  async findOneAndUpdate(filter: Filter<TSchema>, update: UpdateFilter<TSchema>, options?: { upsert?: boolean; returnDocument?: string }) {
    await this.updateOne(filter, update, { upsert: options?.upsert });
    return this.findOne(filter);
  }

  async countDocuments(filter: Filter<TSchema> = {}): Promise<number> {
    return this.docs.filter((doc) => matchesFilter(doc, filter as DocRecord)).length;
  }

  aggregate<T = Document>(pipeline: DocRecord[]): { toArray(): Promise<T[]> } {
    return {
      toArray: async () => {
        const groupStage = pipeline.find((stage) => "$group" in stage)?.$group;
        if (!groupStage) return [];
        const field = String(groupStage._id).replace(/^\$/, "");
        const counts = new Map<string, number>();
        for (const doc of this.docs) {
          const key = String(doc[field] ?? "");
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        return [...counts.entries()].map(([_id, count]) => ({ _id, count } as unknown as T));
      },
    };
  }
}

class InMemoryDb {
  private collections = new Map<string, InMemoryCollection<any>>();

  collection<TSchema extends Document = Document>(name: string): Collection<TSchema> {
    let col = this.collections.get(name);
    if (!col) {
      col = new InMemoryCollection<TSchema>();
      this.collections.set(name, col);
    }
    return col as unknown as Collection<TSchema>;
  }
}

let memoryDbPromise: Promise<Db> | undefined;

export async function getInMemoryPreviewDb(): Promise<Db> {
  if (!memoryDbPromise) {
    memoryDbPromise = (async () => {
      const mem = new InMemoryDb();
      const db = mem as unknown as Db;
      const now = new Date();
      const roundPolicyMap = new Map(initialRoundData.policies.map((p) => [p.id, p]));

      for (const entry of catalogueData) {
        const roundPolicy = roundPolicyMap.get(entry.policyId);
        const version = roundPolicy ? roundPolicy.policyVersion : entry.version;
        await db.collection("policy_revisions").insertOne({
          policyId: entry.policyId,
          revisionId: version,
          version,
          title: entry.title,
          division: entry.division,
          domain: entry.domain,
          domainSlug: entry.domainSlug,
          anchor: entry.anchor,
          url: entry.url,
          statement: entry.statement,
          outcomes: entry.outcomes,
          details: entry.details,
          body: entry.details,
          detailHtml: entry.detailHtml,
          provenance: entry.provenance,
          source: initialRoundData.source,
          importedAt: now,
          createdAt: now,
        });
      }

      const pol010Base = catalogueData.find((e) => e.policyId === "POL-010")!;
      await db.collection("policy_revisions").insertOne({
        policyId: "POL-010",
        revisionId: "POL-010:v2-settled",
        version: "v2-settled",
        title: pol010Base.title,
        division: pol010Base.division,
        domain: pol010Base.domain,
        domainSlug: pol010Base.domainSlug,
        anchor: pol010Base.anchor,
        url: pol010Base.url,
        statement: "Implement a nationally consistent Land Value Tax framework that applies by default, abolishes residential stamp duty with a five-year credit window for prior stamp duty paid, and requires a broad land-only tax base while allowing states to displace the federal tax with a compliant state system.",
        outcomes: pol010Base.outcomes,
        details: `${pol010Base.details}\n\n**[SYNTHETIC PREVIEW FIXTURE] Settled revision note (v2-settled)**\n\nSynthetic test fixture demonstrating how a revision is settled after member consultation (adding a five-year lookback window for crediting prior residential stamp duty). Not an actual party decision.`,
        body: `${pol010Base.details}\n\n**[SYNTHETIC PREVIEW FIXTURE] Settled revision note (v2-settled)**\n\nSynthetic test fixture demonstrating how a revision is settled after member consultation (adding a five-year lookback window for crediting prior residential stamp duty). Not an actual party decision.`,
        changeSummary: "[SYNTHETIC PREVIEW FIXTURE] Simulated post-consultation amendment adding a five-year stamp duty credit window (not an actual party decision).",
        detailHtml: pol010Base.detailHtml,
        provenance: pol010Base.provenance,
        syntheticFixture: true,
        fixtureNotice: "SYNTHETIC PREVIEW FIXTURE — Simulated settled revision for testing ballot workflow; not an actual Fusion party policy revision or decision.",
        createdAt: new Date(now.getTime() + 1000),
        createdBy: "preview-admin-01",
      });

      const followOnPolicyRevision = {
        policyId: "POL-077",
        revisionId: "POL-077:v1-proposed",
        version: "v1-proposed",
        title: "Guarantee Right to Repair for Farm and Consumer Equipment",
        division: "RECLAIM OUR ECONOMY",
        domain: "Build up Small Businesses",
        domainSlug: "/reclaim-our-economy/build-up-small-businesses/",
        anchor: "guarantee-right-to-repair-for-farm-and-consumer-equipment",
        url: "/reclaim-our-economy/build-up-small-businesses/#guarantee-right-to-repair-for-farm-and-consumer-equipment",
        statement: "Require equipment and device manufacturers selling in Australia to provide independent repairers and owners with fair access to diagnostic tools, spare parts, repair manuals, and software resets on non-discriminatory terms.",
        outcomes: [
          "Small businesses, farmers, and households will face lower repair costs and less equipment downtime.",
          "Independent repair workshops will be able to compete fairly with authorised manufacturer service networks.",
          "Premature equipment replacement and electronic waste will decline as repair becomes practical.",
        ],
        details: "**[SYNTHETIC PREVIEW FIXTURE] Design rationale**\n\nSynthetic preview fixture for testing continuous post-AGM policy development. Manufacturers increasingly use software locks, proprietary diagnostics, and parts restrictions to monopolise post-sale repair.",
        body: "**[SYNTHETIC PREVIEW FIXTURE] Design rationale**\n\nSynthetic preview fixture for testing continuous post-AGM policy development. Manufacturers increasingly use software locks, proprietary diagnostics, and parts restrictions to monopolise post-sale repair.",
        detailHtml: "<p><strong>[SYNTHETIC PREVIEW FIXTURE] Design rationale</strong></p><p>Synthetic preview fixture for testing continuous post-AGM policy development. Manufacturers increasingly use software locks, proprietary diagnostics, and parts restrictions to monopolise post-sale repair.</p>",
        syntheticFixture: true,
        fixtureNotice: "SYNTHETIC PREVIEW FIXTURE — Simulated post-AGM policy proposal for testing the Engage lifecycle. Not an actual Fusion party proposal or decision.",
        provenance: {
          category: "new-proposal",
          label: "Synthetic fixture · New proposal",
          summary: "SYNTHETIC PREVIEW FIXTURE: Simulated post-AGM policy proposal for Engage-readiness verification. Not an actual party policy proposal.",
          flaggedNewInStaticExport: false,
          lineageVerified: false,
          materialEquivalenceVerified: false,
          uncertaintyNote: "Synthetic test fixture only — not part of the imported Reclaim baseline or official party platform.",
          lineage: [],
          valuesAlignment: ["Principle: *Inclusive Economic Advancement* — Independent repair rights reduce monopolistic lock-in for small businesses and households."],
        },
        createdAt: now,
        createdBy: "preview-admin-01",
      };
      await db.collection("policy_revisions").insertOne(followOnPolicyRevision);

      await db.collection("consultation_rounds").insertOne({
        roundId: initialRoundData.id,
        version: initialRoundData.version,
        program: initialRoundData.program,
        label: initialRoundData.program,
        timezone: initialRoundData.timezone,
        status: "open",
        opensAt: new Date(now.getTime() - 24 * 60 * 60 * 1000),
        closesAt: new Date("2099-01-01T00:00:00.000Z"),
        scheduledOpensAt: new Date(initialRoundData.openingInclusiveUtc),
        scheduledClosesAt: new Date(initialRoundData.closingExclusiveUtc),
        meeting: initialRoundData.meeting,
        rules: initialRoundData.rules,
        policyIds: initialRoundData.policies.map(({ id }) => id),
        activationGates: initialRoundData.activationGates,
        bindingBallotsEnabled: false,
        createdAt: now,
      });

      await db.collection("consultation_rounds").insertOne({
        roundId: "continuous-policy-round-2027-q1",
        version: "2027-01-15",
        program: "[Synthetic Preview Fixture] Continuous policy development round (Q1 2027 simulation)",
        label: "[Synthetic Preview Fixture] Continuous policy development round (Q1 2027 simulation)",
        description: "SYNTHETIC PREVIEW FIXTURE: Simulated post-AGM consultation round used to verify continuous policy creation, amendment, settlement, voting, and publication. Not an actual party consultation schedule.",
        timezone: "Australia/Sydney",
        status: "open",
        opensAt: new Date(now.getTime() - 24 * 60 * 60 * 1000),
        closesAt: new Date("2099-01-01T00:00:00.000Z"),
        policyIds: ["POL-077", "POL-001", "POL-033"],
        bindingBallotsEnabled: false,
        syntheticFixture: true,
        fixtureNotice: "SYNTHETIC PREVIEW FIXTURE — Simulated post-AGM consultation round, not an actual party governance event.",
        createdAt: now,
      });

      const openPreviewPolicyIds = new Set(["POL-010", "POL-025", "POL-039", "POL-047"]);
      for (const policy of initialRoundData.policies) {
        const isOpenInPreview = openPreviewPolicyIds.has(policy.id);
        const pinnedRevision = policy.id === "POL-010" ? "POL-010:v2-settled" : policy.policyVersion;
        await db.collection("ballots").insertOne({
          ballotId: policy.ballot.id,
          proposalId: policy.id,
          policyRevisionId: pinnedRevision,
          roundId: initialRoundData.id,
          title: policy.title,
          summary: policy.statement,
          domain: policy.domain,
          status: isOpenInPreview ? "open" : "draft",
          opensAt: isOpenInPreview ? new Date(now.getTime() - 24 * 60 * 60 * 1000) : new Date(policy.ballot.opensAt),
          closesAt: isOpenInPreview ? new Date("2099-01-01T00:00:00.000Z") : new Date(policy.ballot.closesAt),
          choices: ["approve", "do-not-approve"],
          mandatoryDoNotApproveReason: false,
          bindingBallotsEnabled: false,
          createdAt: now,
        });
      }

      await db.collection("ballots").insertOne({
        ballotId: "adoption-reclaim-platform",
        proposalId: "GOV-RECLAIM-PLATFORM",
        policyRevisionId: "gov-v1:reclaim-platform",
        roundId: initialRoundData.id,
        title: "Adopt the Reclaim policy platform structure",
        summary: "Adopt the Reclaim policy library structure and progressive-disclosure format as Fusion's member policy platform.",
        domain: "Platform & Branding Review",
        status: "draft",
        opensAt: new Date(initialRoundData.openingInclusiveUtc),
        closesAt: new Date(initialRoundData.closingExclusiveUtc),
        choices: ["approve", "do-not-approve"],
        mandatoryDoNotApproveReason: false,
        bindingBallotsEnabled: false,
        createdAt: now,
      });

      await db.collection("ballots").insertOne({
        ballotId: "adoption-horizon-identity",
        proposalId: "GOV-HORIZON-IDENTITY",
        policyRevisionId: "gov-v1:horizon-identity",
        roundId: initialRoundData.id,
        title: "Adopt the Horizon visual identity and logo",
        summary: "Adopt the Horizon visual identity, colour palette, and logo across Fusion's public and member platforms.",
        domain: "Platform & Branding Review",
        status: "draft",
        opensAt: new Date(initialRoundData.openingInclusiveUtc),
        closesAt: new Date(initialRoundData.closingExclusiveUtc),
        choices: ["approve", "do-not-approve"],
        mandatoryDoNotApproveReason: false,
        bindingBallotsEnabled: false,
        createdAt: now,
      });

      await db.collection("ballots").insertOne({
        ballotId: "ballot-pol-077",
        proposalId: "POL-077",
        policyRevisionId: followOnPolicyRevision.revisionId,
        roundId: "continuous-policy-round-2027-q1",
        title: followOnPolicyRevision.title,
        summary: followOnPolicyRevision.statement,
        domain: followOnPolicyRevision.domain,
        status: "draft",
        opensAt: new Date("2027-02-01T00:00:00.000Z"),
        closesAt: new Date("2027-03-01T00:00:00.000Z"),
        choices: ["approve", "do-not-approve"],
        mandatoryDoNotApproveReason: false,
        bindingBallotsEnabled: false,
        syntheticFixture: true,
        fixtureNotice: "SYNTHETIC PREVIEW FIXTURE — Simulated ballot for Engage lifecycle verification.",
        createdAt: now,
      });

      // Seed one synthetic consultation submission fixture on POL-010 to show how consultation -> settled revision v2 works
      const seedSubId = new ObjectId();
      await db.collection("consultation_submissions").insertOne({
        _id: seedSubId,
        submissionId: seedSubId.toHexString(),
        roundId: initialRoundData.id,
        policyId: "POL-010",
        policyRevisionId: "demo-v1:POL-010",
        kind: "amendment",
        title: "[Synthetic preview fixture] Specify five-year transitional credit window for recent stamp duty",
        body: "SYNTHETIC PREVIEW FIXTURE: Households who recently bought a home and paid stamp duty should have a clear minimum five-year lookback window credited against Land Value Tax so recent first-home buyers are not taxed twice.",
        memberId: "preview-member-01",
        identitySource: "synthetic",
        syntheticFixture: true,
        status: "accepted",
        moderatorResponse: "[Synthetic preview fixture] Accepted in preview simulation and incorporated into synthetic revision POL-010:v2-settled.",
        reviewedBy: "preview-admin-01",
        reviewedAt: now,
        createdAt: new Date(now.getTime() - 3600_000),
        updatedAt: now,
      });

      return db;
    })();
  }
  return memoryDbPromise;
}
