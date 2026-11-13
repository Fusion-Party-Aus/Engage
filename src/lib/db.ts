import { ensureDigestCohort } from "./digest-preferences.ts";
import { ensureVoteStorage, PROPOSAL_VOTES } from "./vote-storage.ts";
import { MongoClient, ObjectId, type ClientSession, type Db } from "mongodb";
import { createHash } from "node:crypto";
import baselineItems from "../data/policies.json" with { type: "json" };
import { ensureLegacyProposalRevision } from "./proposal-revision.ts";
import type { PlatformEnv, ProposalRecord, ProposalStage } from "./types.ts";

let clientPromise: Promise<MongoClient> | undefined;
let clientUri: string | undefined;
let mongoFallbackUntil = 0;
const dbInstanceCache = new Map<string, Db>();
const seededDbs = new WeakMap<object, Promise<void>>();

export function runtimeEnv(locals?: unknown): PlatformEnv {
  const runtime = locals as
    { runtime?: { env?: PlatformEnv }; env?: PlatformEnv } | undefined;
  return {
    ...(process.env as unknown as PlatformEnv),
    ...(runtime?.runtime?.env ?? {}),
    ...(runtime?.env ?? {}),
  };
}

export async function getDatabase(
  env: PlatformEnv = runtimeEnv(),
): Promise<Db> {
  const uri = env.MONGODB_URI;
  const dbName = env.MONGODB_DB_NAME || "engage";

  if (!uri) {
    if (env.APP_MODE === "production") {
      throw new Error("MONGODB_URI is required in production.");
    }
    const memDb = getMemoryDb();
    await ensureSeeded(memDb);
    return memDb;
  }

  if (env.APP_MODE !== "production" && Date.now() < mongoFallbackUntil) {
    const memDb = getMemoryDb();
    await ensureSeeded(memDb);
    return memDb;
  }

  try {
    if (clientUri !== uri || !clientPromise) {
      clientUri = uri;
      dbInstanceCache.clear();
      clientPromise = new MongoClient(uri, {
        maxPoolSize: 10,
        serverSelectionTimeoutMS: env.APP_MODE === "production" ? 3_000 : 400,
        connectTimeoutMS: env.APP_MODE === "production" ? 3_000 : 400,
      }).connect();
    }
    const client = await clientPromise;
    const cacheKey = `${uri}::${dbName}`;
    let db = dbInstanceCache.get(cacheKey);
    if (!db) {
      db = client.db(dbName);
      dbInstanceCache.set(cacheKey, db);
    }
    await ensureSeeded(db);
    return db;
  } catch (error) {
    clientUri = undefined;
    clientPromise = undefined;
    dbInstanceCache.clear();
    if (env.APP_MODE !== "production") {
      mongoFallbackUntil = Date.now() + 60_000;
      const memDb = getMemoryDb();
      await ensureSeeded(memDb);
      return memDb;
    }
    throw error;
  }
}

function mapBaselineStage(defaultStatus?: string): ProposalStage {
  if (defaultStatus === "voting" || defaultStatus === "decide") return "decide";
  if (defaultStatus === "adopted" || defaultStatus === "implement")
    return "implement";
  if (defaultStatus === "draft" || defaultStatus === "propose")
    return "propose";
  return "deliberate";
}

async function ensureSeeded(db: Db): Promise<void> {
  let pending = seededDbs.get(db);
  if (!pending) {
    pending = initializeDatabase(db).catch((error) => {
      seededDbs.delete(db);
      throw error;
    });
    seededDbs.set(db, pending);
  }
  await pending;
}

export async function initializeDatabase(db: Db): Promise<void> {
  await ensureDigestCohort(db);
  await Promise.all([
    db.collection("sense_submissions").createIndex({branchId:1,createdAt:-1}),
    db.collection("rate_limits").createIndex({expiresAt:1},{expireAfterSeconds:0,name:"rate_limit_expiry"}),
  ]);
  await Promise.all([
    db.collection("engagement_lifecycle_events").createIndex({memberId:1,event:1,at:1}),
    db.collection("engagement_email_preferences").createIndex({memberId:1}, {unique:true}),
    db.collection("engagement_email_outbox").createIndex({providerId:1}),
    db.collection("engagement_email_outbox").createIndex({memberId:1,createdAt:-1}),
    db.collection("engagement_email_events").createIndex({providerId:1}),
    db.collection("engagement_reengagement_campaigns").createIndex({campaignId:1},{unique:true}),
    db.collection("push_subscriptions").createIndex({memberId:1,endpoint:1},{unique:true}),
    db.collection("push_subscriptions").createIndex({subscriptionId:1},{unique:true}),
    db.collection("member_notifications").createIndex({memberId:1,createdAt:-1}),
    db.collection("member_notifications").createIndex({notificationId:1},{unique:true}),
    db.collection("notification_deliveries").createIndex({dedupeKey:1},{unique:true}),
    db.collection("crm_identity_links").createIndex({memberId:1,application:1},{unique:true}),
    db.collection("crm_identity_links").createIndex({crmPersonId:1}),
    db.collection("crm_identity_links").createIndex({application:1,status:1,nextCheckAt:1}),
    db.collection("membership_verification_attempts").createIndex({status:1,nextAttemptAt:1}),
    db.collection("membership_verification_attempts").createIndex({status:1,lockedAt:1}),
    db.collection("membership_verification_reviews").createIndex({reviewId:1},{unique:true}),
    db.collection("membership_verification_reviews").createIndex({memberId:1,status:1}),
    db.collection("membership_verification_reviews").createIndex({status:1,createdAt:1}),
    db.collection("membership_verification_events").createIndex({eventId:1},{unique:true}),
    db.collection("membership_verification_events").createIndex({memberId:1,createdAt:-1}),
  ]);
  try {
    await ensureVoteStorage(db);
    await Promise.all([
      db
        .collection("proposals")
        .createIndex({ proposalId: 1 }, { unique: true })
        .catch(() => {}),
      db
        .collection("proposals")
        .createIndex({ slug: 1 }, { unique: true })
        .catch(() => {}),
      db
        .collection("proposals")
        .createIndex({ stage: 1, space: 1 })
        .catch(() => {}),
      db
        .collection("comments")
        .createIndex({ commentId: 1 }, { unique: true })
        .catch(() => {}),
      db
        .collection("comments")
        .createIndex({ proposalId: 1, createdAt: 1 })
        .catch(() => {}),
      db
        .collection("comments")
        .createIndex({ memberId: 1, createdAt: 1 })
        .catch(() => {}),
      db
        .collection(PROPOSAL_VOTES)
        .createIndex({ proposalId: 1, updatedAt: -1 })
        .catch(() => {}),
      db
        .collection(PROPOSAL_VOTES)
        .createIndex({ memberId: 1, updatedAt: 1 })
        .catch(() => {}),
      db
        .collection("proposals")
        .createIndex({ authorId: 1, createdAt: 1 })
        .catch(() => {}),
      db
        .collection("ballots")
        .createIndex({ ballotId: 1 }, { unique: true })
        .catch(() => {}),
      db
        .collection("ballots")
        .createIndex({ matterId: 1, status: 1 })
        .catch(() => {}),
      db
        .collection("governance_events")
        .createIndex({ eventId: 1 }, { unique: true })
        .catch(() => {}),
      db
        .collection("governance_events")
        .createIndex({ matterId: 1, createdAt: -1 })
        .catch(() => {}),
      db
        .collection("governance_relationships")
        .createIndex({ sourceMatterId: 1, relationshipType: 1 })
        .catch(() => {}),
      db
        .collection("governance_relationships")
        .createIndex({ targetMatterId: 1, relationshipType: 1 })
        .catch(() => {}),
      db
        .collection("memberships")
        .createIndex(
          { memberId: 1 },
          { unique: true, name: "membership_member_unique" },
        )
        .catch(() => {}),
      db.collection("memberships").createIndex({ status: 1 }).catch(() => {}),
      db
        .collection("application_roles")
        .createIndex(
          { memberId: 1, role: 1 },
          { unique: true, name: "member_role_unique" },
        )
        .catch(() => {}),
      db
        .collection("branches")
        .createIndex({ branchId: 1 }, { unique: true })
        .catch(() => {}),
      db
        .collection("proposal_revisions")
        .createIndex({ revisionId: 1 }, { unique: true })
        .catch(() => {}),
      db
        .collection("proposal_revisions")
        .createIndex({ proposalId: 1, createdAt: 1 })
        .catch(() => {}),
      db
        .collection("policy_registry")
        .createIndex({ policyId: 1 }, { unique: true })
        .catch(() => {}),
      db
        .collection("publication_events")
        .createIndex({ eventId: 1 }, { unique: true })
        .catch(() => {}),
      (async () => {
        const col = db.collection("ballot_results");
        const existing =
          typeof col.indexes === "function"
            ? await col.indexes().catch(() => [])
            : [];
        const legacyIdx = existing.find(
          (idx) => idx.name === "proposalId_1" && idx.unique === true,
        );
        if (legacyIdx) {
          await col.dropIndex("proposalId_1").catch(() => {});
        }
        await col
          .createIndex(
            { ballotId: 1 },
            {
              unique: true,
              name: "ballot_results_ballot_unique",
              partialFilterExpression: { ballotId: { $type: "string" } },
            },
          )
          .catch(() => {});
        await col.createIndex({ proposalId: 1 }).catch(() => {});
      })(),
      db
        .collection("ballot_binding_events")
        .createIndex({ eventId: 1 }, { unique: true })
        .catch(() => {}),
      db
        .collection("amendments")
        .createIndex({ amendmentId: 1 }, { unique: true })
        .catch(() => {}),
      db
        .collection("amendments")
        .createIndex({ proposalId: 1, status: 1, createdAt: 1 })
        .catch(() => {}),
      db
        .collection("amendment_revisions")
        .createIndex({ revisionId: 1 }, { unique: true })
        .catch(() => {}),
      db
        .collection("amendment_revisions")
        .createIndex({ amendmentId: 1, createdAt: 1 })
        .catch(() => {}),
      db
        .collection("branch_memberships")
        .createIndex({ branchId: 1, memberId: 1 }, { unique: true })
        .catch(() => {}),
      db
        .collection("branch_memberships")
        .createIndex({ memberId: 1, status: 1, branchRole: 1, branchId: 1 })
        .catch(() => {}),
      db
        .collection("branch_memberships")
        .createIndex({ branchId: 1, status: 1 })
        .catch(() => {}),
      db
        .collection("branch_memberships")
        .createIndex({ source: 1, branchId: 1 })
        .catch(() => {}),
      db
        .collection("branch_subscriptions")
        .createIndex(
          { memberId: 1, branchId: 1 },
          { unique: true, name: "branch_subscription_member_unique" },
        )
        .catch(() => {}),
      db
        .collection("branch_subscriptions")
        .createIndex({ branchId: 1, status: 1 })
        .catch(() => {}),
      db
        .collection("branch_subscriptions")
        .createIndex({ memberId: 1, status: 1 })
        .catch(() => {}),
      db
        .collection("branch_subscription_events")
        .createIndex({ eventId: 1 }, { unique: true })
        .catch(() => {}),
      db
        .collection("branch_subscription_events")
        .createIndex({ memberId: 1, createdAt: -1 })
        .catch(() => {}),
      db
        .collection("branch_membership_events")
        .createIndex({ eventId: 1 }, { unique: true })
        .catch(() => {}),
      db
        .collection("branch_membership_events")
        .createIndex({ branchId: 1, memberId: 1, createdAt: 1 })
        .catch(() => {}),
      db
        .collection("branch_events")
        .createIndex({ eventId: 1 }, { unique: true })
        .catch(() => {}),
      db
        .collection("branch_events")
        .createIndex({ branchId: 1, createdAt: 1 })
        .catch(() => {}),
      db
        .collection("branch_referrals")
        .createIndex({ proposalId: 1, targetBranchId: 1 }, { unique: true })
        .catch(() => {}),
      db
        .collection("branch_referrals")
        .createIndex({ referralId: 1 }, { unique: true })
        .catch(() => {}),
      db
        .collection("site_settings_events")
        .createIndex({ eventId: 1 }, { unique: true })
        .catch(() => {}),
      db
        .collection("site_settings_events")
        .createIndex({ createdAt: -1 })
        .catch(() => {}),
      db
        .collection("data_migrations")
        .createIndex(
          { migrationId: 1 },
          { unique: true, name: "data_migration_unique" },
        )
        .catch(() => {}),
    ]);

    const now = new Date();
    // Preserve existing amendment records while assigning a first immutable wording revision.
    const amendments = await db.collection("amendments").find({}).toArray();
    for (const amendment of amendments) {
      if (amendment.currentRevisionId) continue;
      const snapshot =
        amendment.changes && typeof amendment.changes === "object"
          ? amendment.changes
          : {};
      const existingRevision = await db
        .collection("amendment_revisions")
        .findOne({ amendmentId: amendment.amendmentId });
      const revisionId =
        existingRevision?.revisionId ??
        `legacy-${createHash("sha256").update(String(amendment.amendmentId)).digest("hex")}`;
      await db
        .collection("amendment_revisions")
        .updateOne(
          { revisionId },
          {
            $setOnInsert: {
              revisionId,
              amendmentId: amendment.amendmentId,
              parentRevisionId: null,
              authorId: amendment.authorId ?? "system:migration",
              createdAt: amendment.createdAt ?? now,
              snapshot,
              contentHash: createHash("sha256")
                .update(JSON.stringify(snapshot))
                .digest("hex"),
              provenance: "legacy-backfill",
            },
          },
          { upsert: true },
        );
      const revision =
        existingRevision ??
        (await db.collection("amendment_revisions").findOne({ revisionId }));
      if (revision)
        await db
          .collection("amendments")
          .updateOne(
            {
              amendmentId: amendment.amendmentId,
              currentRevisionId: { $exists: false },
            },
            { $set: { currentRevisionId: revision.revisionId } },
          );
    }
    const proposalsCol = db.collection<ProposalRecord>("proposals");
    await Promise.all(
      baselineItems.map((item) => {
        const raw = item as Record<string, any>;
        const proposalId = String(raw.proposalId || raw.policyId);
        const stage = mapBaselineStage(raw.stage || raw.defaultStatus);
        const kind =
          raw.kind || (proposalId.startsWith("GOV-") ? "resolution" : "policy");

        // Seeding is insert-only. A restart must not rewrite an existing proposal,
        // including its updatedAt timestamp, because that would make routine
        // initialisation look like a substantive content change.
        return proposalsCol.updateOne(
          { proposalId },
          {
            $setOnInsert: {
              proposalId,
              slug: String(raw.slug),
              title: String(raw.title),
              space: String(raw.space || raw.category || "General"),
              spaceSummary: String(raw.spaceSummary || raw.categorySummary || ""),
              summary: String(raw.summary || raw.statement || ""),
              outcomes: Array.isArray(raw.outcomes) ? raw.outcomes : [],
              details: String(raw.details || ""),
              ...(raw.provenance ? { provenance: raw.provenance } : {}),
              ...(raw.detailHtml ? { detailHtml: raw.detailHtml } : {}),
              ...(raw.attachmentUrl
                ? { attachmentUrl: String(raw.attachmentUrl) }
                : {}),
              ...(raw.attachmentDescription
                ? { attachmentDescription: String(raw.attachmentDescription) }
                : {}),
              stage,
              kind,
              authorName: "Fusion Working Group",
              createdAt: now,
              updatedAt: now,
            },
          },
          { upsert: true },
        );
      }),
    );

    // Backfill one immutable starting revision for legacy records. Existing
    // proposal and vote documents are untouched; the hash makes this restartable.
    // Ballots are never bound here: a ballot whose votes are not already bound to
    // one immutable revision requires an explicit, reviewed migration decision.
    const existingProposals = await proposalsCol.find({}).toArray();
    await Promise.all(
      existingProposals.map((proposal) =>
        ensureLegacyProposalRevision(db, proposal),
      ),
    );
  } catch (error) {
    seededDbs.delete(db);
    throw error;
  }
}

export async function closeDatabase(): Promise<void> {
  const pending = clientPromise;
  clientPromise = undefined;
  clientUri = undefined;
  mongoFallbackUntil = 0;
  dbInstanceCache.clear();
  if (pending) await (await pending).close();
}

let sharedMemoryDb: Db | undefined;

export function createMemoryDb(): Db {
  const collections = new Map<string, Array<Record<string, any>>>();

  const matchesFilter = (
    doc: Record<string, any>,
    filter: Record<string, any> = {},
  ): boolean => {
    for (const [key, cond] of Object.entries(filter)) {
      if (key === "$or" && Array.isArray(cond)) {
        if (!cond.some((sub) => matchesFilter(doc, sub))) return false;
        continue;
      }
      const val = key
        .split(".")
        .reduce<any>(
          (value, part) =>
            value && typeof value === "object" ? value[part] : undefined,
          doc,
        );
      if (
        cond &&
        typeof cond === "object" &&
        !(cond instanceof Date) &&
        !(cond instanceof ObjectId) &&
        !(cond instanceof RegExp)
      ) {
        if ("$in" in cond && Array.isArray(cond.$in)) {
          if (!cond.$in.some((item: any) => String(item) === String(val)))
            return false;
          continue;
        }
        if ("$exists" in cond) {
          if (key in doc !== Boolean(cond.$exists)) return false;
          continue;
        }
        if ("$nin" in cond) {
          if (cond.$nin.includes(val)) return false;
          continue;
        }
        if ("$ne" in cond) {
          if (val === cond.$ne) return false;
          continue;
        }
        const asComparable = (value: any) =>
          value instanceof Date ? value.getTime() : value;
        if ("$gt" in cond && !(asComparable(val) > asComparable(cond.$gt)))
          return false;
        if ("$gte" in cond && !(asComparable(val) >= asComparable(cond.$gte)))
          return false;
        if ("$lt" in cond && !(asComparable(val) < asComparable(cond.$lt)))
          return false;
        if ("$lte" in cond && !(asComparable(val) <= asComparable(cond.$lte)))
          return false;
        if (["$gt", "$gte", "$lt", "$lte"].some((operator) => operator in cond))
          continue;
      }
      if (cond instanceof RegExp) {
        if (!cond.test(String(val ?? ""))) return false;
      } else if (
        key === "_id" ||
        cond instanceof ObjectId ||
        val instanceof ObjectId ||
        cond?._bsontype === "ObjectId" ||
        val?._bsontype === "ObjectId"
      ) {
        if (String(val) !== String(cond)) return false;
      } else if (val !== cond) {
        return false;
      }
    }
    return true;
  };

  const getStore = (name: string) => {
    if (!collections.has(name)) collections.set(name, []);
    return collections.get(name)!;
  };

  return {
    command: async () => ({ ok: 1 }),
    collection(name: string) {
      const store = getStore(name);
      return {
        createIndex: async () => "ok",
        countDocuments: async (filter: Record<string, any> = {}) =>
          store.filter((doc) => matchesFilter(doc, filter)).length,
        find(filter: Record<string, any> = {}) {
          let results = store
            .filter((doc) => matchesFilter(doc, filter))
            .map((d) => ({ ...d }));
          const cursor = {
            sort(spec: Record<string, 1 | -1>) {
              const entries = Object.entries(spec);
              results.sort((a, b) => {
                for (const [field, dir] of entries) {
                  const av = a[field];
                  const bv = b[field];
                  if (av < bv) return -1 * dir;
                  if (av > bv) return 1 * dir;
                }
                return 0;
              });
              return cursor;
            },
            limit(n: number) {
              results = results.slice(0, n);
              return cursor;
            },
            project() {
              return cursor;
            },
            toArray: async () => results,
          };
          return cursor;
        },
        findOne: async (filter: Record<string, any> = {}) => {
          const found = store.find((doc) => matchesFilter(doc, filter));
          return found ? { ...found } : null;
        },
        insertOne: async (doc: Record<string, any>) => {
          const _id = doc._id ?? new ObjectId();
          if (store.some(existing => String(existing._id) === String(_id))) {
            throw Object.assign(new Error('Duplicate _id'), {code:11000});
          }
          const record = { ...doc, _id };
          store.push(record);
          return { insertedId: _id, acknowledged: true };
        },
        updateOne: async (
          filter: Record<string, any>,
          update: {
            $set?: Record<string, any>;
            $setOnInsert?: Record<string, any>;
            $inc?: Record<string, number>;
            $unset?: Record<string, any>;
          },
          options?: { upsert?: boolean },
        ) => {
          const idx = store.findIndex((doc) => matchesFilter(doc, filter));
          if (idx >= 0) {
            if (update.$set) Object.assign(store[idx]!, update.$set);
            // Atomic in MongoDB; the in-memory preview only needs the semantics.
            for (const [field, amount] of Object.entries(update.$inc ?? {})) {
              store[idx]![field] = Number(store[idx]![field] ?? 0) + amount;
            }
            for (const field of Object.keys(update.$unset || {})) delete store[idx]![field];
            return { matchedCount: 1, modifiedCount: 1, acknowledged: true };
          }
          if (options?.upsert) {
            const _id = new ObjectId();
            const doc: Record<string, any> = { _id };
            for (const [k, v] of Object.entries(filter)) {
              if (
                typeof v !== "object" ||
                v instanceof ObjectId ||
                v instanceof Date
              )
                doc[k] = v;
            }
            if (update.$setOnInsert) Object.assign(doc, update.$setOnInsert);
            if (update.$set) Object.assign(doc, update.$set);
            for (const [field, amount] of Object.entries(update.$inc ?? {})) {
              doc[field] = Number(doc[field] ?? 0) + amount;
            }
            store.push(doc);
            return {
              matchedCount: 0,
              modifiedCount: 0,
              upsertedId: _id,
              acknowledged: true,
            };
          }
          return { matchedCount: 0, modifiedCount: 0, acknowledged: true };
        },
        findOneAndUpdate: async (
          filter: Record<string, any>,
          update: {
            $set?: Record<string, any>;
            $setOnInsert?: Record<string, any>;
            $inc?: Record<string, number>;
            $unset?: Record<string, any>;
          },
          options?: { upsert?: boolean; returnDocument?: "before" | "after" },
        ) => {
          const idx = store.findIndex((doc) => matchesFilter(doc, filter));
          if (idx >= 0) {
            const before = { ...store[idx]! };
            if (update.$set) Object.assign(store[idx]!, update.$set);
            for (const [field, amount] of Object.entries(update.$inc ?? {})) {
              store[idx]![field] = Number(store[idx]![field] ?? 0) + amount;
            }
            for (const field of Object.keys(update.$unset || {})) delete store[idx]![field];
            return options?.returnDocument === "before" ? { ...before } : { ...store[idx]! };
          }
          if (!options?.upsert) return null;
          const _id = new ObjectId();
          const doc: Record<string, any> = { _id };
          for (const [k, v] of Object.entries(filter)) {
            if (
              typeof v !== "object" ||
              v instanceof ObjectId ||
              v instanceof Date
            )
              doc[k] = v;
          }
          if (update.$setOnInsert) Object.assign(doc, update.$setOnInsert);
          if (update.$set) Object.assign(doc, update.$set);
          for (const [field, amount] of Object.entries(update.$inc ?? {})) {
            doc[field] = Number(doc[field] ?? 0) + amount;
          }
          store.push(doc);
          return { ...doc };
        },
        deleteOne: async (filter: Record<string, any>) => {
          const idx = store.findIndex((doc) => matchesFilter(doc, filter));
          if (idx >= 0) {
            store.splice(idx, 1);
            return { deletedCount: 1, acknowledged: true };
          }
          return { deletedCount: 0, acknowledged: true };
        },
        deleteMany: async (filter: Record<string, any> = {}) => {
          const before = store.length;
          const kept = store.filter((doc) => !matchesFilter(doc, filter));
          store.length = 0;
          store.push(...kept);
          return { deletedCount: before - kept.length, acknowledged: true };
        },
      };
    },
  } as unknown as Db;
}

function getMemoryDb(): Db {
  if (!sharedMemoryDb) sharedMemoryDb = createMemoryDb();
  return sharedMemoryDb;
}

/**
 * Run a persistence callback inside a MongoDB transaction when supported by
 * the underlying client (e.g. a real replica set). Falls back to direct
 * execution on the in-memory development/test database.
 */
export async function runInTransaction<T>(
  db: Db,
  fn: (session?: ClientSession) => Promise<T>,
): Promise<T> {
  const dbClient = (db as Db & { client?: MongoClient }).client;
  if (!dbClient || typeof dbClient.startSession !== "function") {
    return fn(undefined);
  }
  const session = dbClient.startSession();
  try {
    let result!: T;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}

