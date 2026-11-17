import { ensureDigestCohort } from "./digest-preferences.ts";
import { ensureDatabaseIndexes } from "./db-indexes.ts";
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

/**
 * Opt-in driver command monitoring used by the rendering-performance harness.
 * It is disabled unless `ENGAGE_DB_COMMAND_MONITOR=1` and the application is
 * not running in production. Counters are process-wide and are only read from
 * the development-only `/api/dev/render-metrics` diagnostic route.
 */
export interface DbCommandMetricsSnapshot {
  enabled: boolean;
  commands: number;
  failed: number;
  durationMs: number;
  byCommand: Record<string, { count: number; durationMs: number }>;
}

const dbCommandMetrics = {
  commands: 0,
  failed: 0,
  durationMs: 0,
  byCommand: new Map<string, { count: number; durationMs: number }>(),
};

export function dbCommandMonitoringEnabled(env: PlatformEnv): boolean {
  return (
    env.ENGAGE_DB_COMMAND_MONITOR === "1" && env.APP_MODE !== "production"
  );
}

function recordDbCommand(commandName: string, durationMs: number): void {
  const name = commandName || "unknown";
  dbCommandMetrics.commands += 1;
  dbCommandMetrics.durationMs += durationMs;
  const entry = dbCommandMetrics.byCommand.get(name) ?? {
    count: 0,
    durationMs: 0,
  };
  entry.count += 1;
  entry.durationMs += durationMs;
  dbCommandMetrics.byCommand.set(name, entry);
}

export function snapshotDbCommandMetrics(
  env: PlatformEnv = runtimeEnv(),
): DbCommandMetricsSnapshot {
  return {
    enabled: dbCommandMonitoringEnabled(env),
    commands: dbCommandMetrics.commands,
    failed: dbCommandMetrics.failed,
    durationMs: Math.round(dbCommandMetrics.durationMs * 1000) / 1000,
    byCommand: Object.fromEntries(
      [...dbCommandMetrics.byCommand.entries()]
        .sort((a, b) => b[1].count - a[1].count)
        .map(([name, value]) => [
          name,
          {
            count: value.count,
            durationMs: Math.round(value.durationMs * 1000) / 1000,
          },
        ]),
    ),
  };
}

export function resetDbCommandMetrics(): void {
  dbCommandMetrics.commands = 0;
  dbCommandMetrics.failed = 0;
  dbCommandMetrics.durationMs = 0;
  dbCommandMetrics.byCommand.clear();
}

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
      const monitorCommands = dbCommandMonitoringEnabled(env);
      const client = new MongoClient(uri, {
        maxPoolSize: 10,
        serverSelectionTimeoutMS: env.APP_MODE === "production" ? 3_000 : 400,
        connectTimeoutMS: env.APP_MODE === "production" ? 3_000 : 400,
        monitorCommands,
      });
      if (monitorCommands) {
        const startedAt = new Map<number, number>();
        client.on("commandStarted", (event) => {
          startedAt.set(event.requestId, performance.now());
        });
        client.on("commandSucceeded", (event) => {
          const started = startedAt.get(event.requestId);
          startedAt.delete(event.requestId);
          recordDbCommand(
            event.commandName,
            started === undefined ? 0 : performance.now() - started,
          );
        });
        client.on("commandFailed", (event) => {
          const started = startedAt.get(event.requestId);
          startedAt.delete(event.requestId);
          dbCommandMetrics.failed += 1;
          recordDbCommand(
            event.commandName,
            started === undefined ? 0 : performance.now() - started,
          );
        });
      }
      clientPromise = client.connect();
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

/**
 * Content half of initialisation: the reminder cohort, legacy revision
 * backfills and the baseline policy register. Insert-only, so a restart never
 * rewrites existing content.
 */
export async function seedBaselineContent(db: Db): Promise<void> {
  await ensureDigestCohort(db);
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
  // One bulk write instead of one round trip per baseline item.
  const operations = baselineItems.map((item) => {
    const raw = item as Record<string, any>;
    const proposalId = String(raw.proposalId || raw.policyId);
    const stage = mapBaselineStage(raw.stage || raw.defaultStatus);
    const kind =
      raw.kind || (proposalId.startsWith("GOV-") ? "resolution" : "policy");

    // Seeding is insert-only. A restart must not rewrite an existing proposal,
    // including its updatedAt timestamp, because that would make routine
    // initialisation look like a substantive content change.
    return {
      updateOne: {
        filter: { proposalId },
        update: {
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
        upsert: true,
      },
    };
  });
  if (operations.length > 0) {
    await proposalsCol.bulkWrite(operations);
  }

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
}

/**
 * Full production initialisation: schema, then baseline content. Callers that
 * initialise a database themselves should use this unless they are certain the
 * case does not depend on the seeded policy register.
 */
export async function initializeDatabase(db: Db): Promise<void> {
  try {
    await ensureDatabaseIndexes(db);
    await seedBaselineContent(db);
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
      if (key === "$and" && Array.isArray(cond)) {
        if (!cond.every((sub) => matchesFilter(doc, sub))) return false;
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
          if (
            !cond.$in.some((item: any) =>
              item instanceof RegExp
                ? item.test(String(val ?? ""))
                : String(item) === String(val),
            )
          )
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
      const collection: Record<string, any> = {
        createIndex: async () => "ok",
        createIndexes: async () => "ok",
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
            skip(n: number) {
              results = results.slice(n);
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
            $addToSet?: Record<string, any>;
            $pull?: Record<string, any>;
          },
          options?: { upsert?: boolean },
        ) => {
          const idx = store.findIndex((doc) => matchesFilter(doc, filter));
          const applySetOperators = (doc: Record<string, any>) => {
            if (update.$set) Object.assign(doc, update.$set);
            for (const [field, amount] of Object.entries(update.$inc ?? {})) {
              doc[field] = Number(doc[field] ?? 0) + amount;
            }
            for (const [field, value] of Object.entries(update.$addToSet ?? {})) {
              const values =
                value && typeof value === "object" && Array.isArray(value.$each)
                  ? value.$each
                  : [value];
              const current = Array.isArray(doc[field]) ? [...doc[field]] : [];
              for (const item of values) {
                if (!current.some((entry) => JSON.stringify(entry) === JSON.stringify(item))) {
                  current.push(item);
                }
              }
              doc[field] = current;
            }
            for (const [field, value] of Object.entries(update.$pull ?? {})) {
              if (Array.isArray(doc[field])) {
                doc[field] = doc[field].filter(
                  (entry: unknown) => JSON.stringify(entry) !== JSON.stringify(value),
                );
              }
            }
            for (const field of Object.keys(update.$unset || {})) delete doc[field];
          };
          if (idx >= 0) {
            applySetOperators(store[idx]!);
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
            applySetOperators(doc);
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
        aggregate: (pipeline: Array<Record<string, any>>) => ({
          toArray: async () => {
            let results = store.map((d) => ({ ...d }));
            for (const stage of pipeline) {
              if (stage.$match) {
                results = results.filter((doc) => matchesFilter(doc, stage.$match));
              } else if (stage.$addFields) {
                results = results.map((doc) => {
                  const next = { ...doc };
                  for (const [field, expr] of Object.entries(stage.$addFields)) {
                    if (expr && typeof expr === "object" && Array.isArray((expr as any).$ifNull)) {
                      const [a, b] = (expr as any).$ifNull as [string, string];
                      const readField = (ref: string) =>
                        ref.startsWith("$") ? next[ref.slice(1)] : ref;
                      next[field] = readField(a) ?? readField(b);
                    }
                  }
                  return next;
                });
              } else if (stage.$sort) {
                const entries = Object.entries(stage.$sort as Record<string, 1 | -1>);
                results.sort((a, b) => {
                  for (const [field, dir] of entries) {
                    const av = field === "_id" ? String(a[field]) : a[field];
                    const bv = field === "_id" ? String(b[field]) : b[field];
                    if (av < bv) return -1 * dir;
                    if (av > bv) return 1 * dir;
                  }
                  return 0;
                });
              } else if (typeof stage.$skip === "number") {
                results = results.slice(stage.$skip);
              } else if (typeof stage.$limit === "number") {
                results = results.slice(0, stage.$limit);
              } else if (stage.$project) {
                const proj = stage.$project as Record<string, 0 | 1>;
                const includes = Object.entries(proj)
                  .filter(([, v]) => v === 1)
                  .map(([k]) => k);
                if (includes.length > 0) {
                  results = results.map((doc) => {
                    const out: Record<string, any> = {};
                    for (const k of includes) {
                      if (k in doc) out[k] = doc[k];
                    }
                    return out;
                  });
                }
              }
            }
            return results;
          },
        }),
      };
      // The preview applies bulk operations in order; the seeding path uses it
      // to keep one round trip in Mongo instead of one write per record.
      collection.bulkWrite = async (
        operations: Array<Record<string, any>>,
      ) => {
        let upsertedCount = 0;
        let matchedCount = 0;
        for (const operation of operations) {
          if (operation.insertOne) {
            await collection.insertOne(operation.insertOne.document);
          } else if (operation.updateOne) {
            const { filter, update, upsert } = operation.updateOne;
            const result = await collection.updateOne(filter, update, {
              upsert,
            });
            matchedCount += result.matchedCount ?? 0;
            if (result.upsertedId) upsertedCount += 1;
          }
        }
        return { acknowledged: true, matchedCount, upsertedCount };
      };
      return collection;
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

