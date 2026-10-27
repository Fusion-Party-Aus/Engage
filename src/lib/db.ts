import { MongoClient, ObjectId, type Db } from "mongodb";
import baselineItems from "../data/policies.json" with { type: "json" };
import type { PlatformEnv, ProposalRecord, ProposalStage } from "./types.ts";

let clientPromise: Promise<MongoClient> | undefined;
let clientUri: string | undefined;
const seededDbs = new WeakSet<object>();

export function runtimeEnv(locals?: unknown): PlatformEnv {
  const runtime = (locals as { runtime?: { env?: PlatformEnv }; env?: PlatformEnv } | undefined);
  return {
    ...(process.env as unknown as PlatformEnv),
    ...(runtime?.runtime?.env ?? {}),
    ...(runtime?.env ?? {}),
  };
}

export async function getDatabase(env: PlatformEnv = runtimeEnv()): Promise<Db> {
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

  try {
    if (clientUri !== uri || !clientPromise) {
      clientUri = uri;
      clientPromise = new MongoClient(uri, {
        maxPoolSize: 5,
        serverSelectionTimeoutMS: 3_000,
        connectTimeoutMS: 3_000,
      }).connect();
    }
    const client = await clientPromise;
    const db = client.db(dbName);
    await ensureSeeded(db);
    return db;
  } catch (error) {
    clientUri = undefined;
    clientPromise = undefined;
    if (env.APP_MODE !== "production") {
      const memDb = getMemoryDb();
      await ensureSeeded(memDb);
      return memDb;
    }
    throw error;
  }
}

function mapBaselineStage(defaultStatus?: string): ProposalStage {
  if (defaultStatus === "voting" || defaultStatus === "decide") return "decide";
  if (defaultStatus === "adopted" || defaultStatus === "implement") return "implement";
  if (defaultStatus === "draft" || defaultStatus === "propose") return "propose";
  return "deliberate";
}

async function ensureSeeded(db: Db): Promise<void> {
  if (seededDbs.has(db)) return;
  seededDbs.add(db);

  try {
    await Promise.all([
      db.collection("proposals").createIndex({ proposalId: 1 }, { unique: true }).catch(() => {}),
      db.collection("proposals").createIndex({ slug: 1 }, { unique: true }).catch(() => {}),
      db.collection("proposals").createIndex({ stage: 1, space: 1 }).catch(() => {}),
      db.collection("comments").createIndex({ commentId: 1 }, { unique: true }).catch(() => {}),
      db.collection("comments").createIndex({ proposalId: 1, createdAt: 1 }).catch(() => {}),
      db.collection("votes").createIndex({ proposalId: 1, memberId: 1 }, { unique: true }).catch(() => {}),
      db.collection("memberships").createIndex({ memberId: 1 }, { unique: true, name: "membership_member_unique" }).catch(() => {}),
      db.collection("application_roles").createIndex({ memberId: 1, role: 1 }, { unique: true, name: "member_role_unique" }).catch(() => {}),
    ]);

    const now = new Date();
    const proposalsCol = db.collection<ProposalRecord>("proposals");
    for (const item of baselineItems) {
      const raw = item as Record<string, any>;
      const proposalId = String(raw.proposalId || raw.policyId);
      const stage = mapBaselineStage(raw.stage || raw.defaultStatus);
      const setFields: Record<string, any> = { updatedAt: now };
      if (raw.provenance) setFields.provenance = raw.provenance;
      if (raw.detailHtml) setFields.detailHtml = raw.detailHtml;

      await proposalsCol.updateOne(
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
            ...(raw.attachmentUrl ? { attachmentUrl: String(raw.attachmentUrl) } : {}),
            stage,
            authorName: "Fusion Working Group",
            createdAt: now,
          },
          $set: setFields,
        },
        { upsert: true },
      );
    }
  } catch (error) {
    seededDbs.delete(db);
    throw error;
  }
}

export async function closeDatabase(): Promise<void> {
  const pending = clientPromise;
  clientPromise = undefined;
  clientUri = undefined;
  if (pending) await (await pending).close();
}

let sharedMemoryDb: Db | undefined;

export function createMemoryDb(): Db {
  const collections = new Map<string, Array<Record<string, any>>>();

  const matchesFilter = (doc: Record<string, any>, filter: Record<string, any> = {}): boolean => {
    for (const [key, cond] of Object.entries(filter)) {
      if (key === "$or" && Array.isArray(cond)) {
        if (!cond.some((sub) => matchesFilter(doc, sub))) return false;
        continue;
      }
      const val = doc[key];
      if (
        cond &&
        typeof cond === "object" &&
        !(cond instanceof Date) &&
        !(cond instanceof ObjectId) &&
        !(cond instanceof RegExp)
      ) {
        if ("$in" in cond && Array.isArray(cond.$in)) {
          if (!cond.$in.some((item: any) => String(item) === String(val))) return false;
          continue;
        }
        if ("$ne" in cond) {
          if (val === cond.$ne) return false;
          continue;
        }
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
          let results = store.filter((doc) => matchesFilter(doc, filter)).map((d) => ({ ...d }));
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
          const record = { ...doc, _id };
          store.push(record);
          return { insertedId: _id, acknowledged: true };
        },
        updateOne: async (
          filter: Record<string, any>,
          update: { $set?: Record<string, any>; $setOnInsert?: Record<string, any> },
          options?: { upsert?: boolean },
        ) => {
          const idx = store.findIndex((doc) => matchesFilter(doc, filter));
          if (idx >= 0) {
            if (update.$set) Object.assign(store[idx]!, update.$set);
            return { matchedCount: 1, modifiedCount: 1, acknowledged: true };
          }
          if (options?.upsert) {
            const _id = new ObjectId();
            const doc: Record<string, any> = { _id };
            for (const [k, v] of Object.entries(filter)) {
              if (typeof v !== "object" || v instanceof ObjectId || v instanceof Date) doc[k] = v;
            }
            if (update.$setOnInsert) Object.assign(doc, update.$setOnInsert);
            if (update.$set) Object.assign(doc, update.$set);
            store.push(doc);
            return { matchedCount: 0, modifiedCount: 0, upsertedId: _id, acknowledged: true };
          }
          return { matchedCount: 0, modifiedCount: 0, acknowledged: true };
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
