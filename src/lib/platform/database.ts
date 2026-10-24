import { MongoClient, type Db } from "mongodb";
import type { PlatformEnv } from "./types.ts";
import { getInMemoryPreviewDb } from "./memory-db.ts";

let clientPromise: Promise<MongoClient> | undefined;
let clientUri: string | undefined;
const indexesByDatabase = new WeakMap<Db, Promise<void>>();

export async function getDatabase(env: PlatformEnv): Promise<Db> {
  const uri = env.MONGODB_URI;
  const databaseName = env.MONGODB_DB_NAME;
  if (!uri || !databaseName) {
    if (env.APP_MODE === "preview") {
      return getInMemoryPreviewDb();
    }
    throw new Error("MongoDB is not configured for this deployment.");
  }

  try {
    if (clientUri !== uri) {
      clientUri = uri;
      clientPromise = new MongoClient(uri, {
        maxPoolSize: 3,
        serverSelectionTimeoutMS: 2_500,
        connectTimeoutMS: 2_500,
      }).connect();
    }

    const client = await clientPromise!;
    return client.db(databaseName);
  } catch (error) {
    clientUri = undefined;
    clientPromise = undefined;
    if (env.APP_MODE === "preview") {
      return getInMemoryPreviewDb();
    }
    throw error;
  }
}

export async function ensureIndexes(db: Db): Promise<void> {
  const existing = indexesByDatabase.get(db);
  if (existing) return existing;
  const creation = Promise.all([
    db.collection("policy_revisions").createIndex({ policyId: 1, version: 1 }, { unique: true, name: "policy_version_unique" }),
    db.collection("policy_revisions").createIndex({ policyId: 1, revisionId: 1 }, { unique: true, name: "policy_revision_id_unique" }),
    db.collection("consultation_rounds").createIndex({ roundId: 1 }, { unique: true, name: "round_id_unique" }),
    db.collection("consultation_rounds").createIndex({ status: 1, opensAt: 1, closesAt: 1 }),
    db.collection("consultation_submissions").createIndex({ submissionId: 1 }, { unique: true, name: "submission_id_unique" }),
    db.collection("consultation_submissions").createIndex({ policyId: 1, status: 1, createdAt: 1 }),
    db.collection("consultation_submissions").createIndex({ memberId: 1, createdAt: -1 }),
    db.collection("consultation_submissions").createIndex({ status: 1, createdAt: 1 }),
    db.collection("ballots").createIndex({ ballotId: 1 }, { unique: true, name: "ballot_id_unique" }),
    db.collection("ballots").createIndex({ proposalId: 1, status: 1 }),
    db.collection("ballots").createIndex({ status: 1, opensAt: 1, closesAt: 1 }),
    db.collection("votes").createIndex({ ballotId: 1, memberId: 1 }, { unique: true, name: "one_current_vote_per_member_ballot" }),
    db.collection("memberships").createIndex({ memberId: 1 }, { unique: true, name: "membership_member_unique" }),
    db.collection("application_roles").createIndex({ memberId: 1, role: 1 }, { unique: true, name: "member_role_unique" }),
    db.collection("operational_audit").createIndex({ createdAt: -1 }),
    db.collection("mutation_rate_limits").createIndex({ scope: 1, subjectId: 1, window: 1 }, { unique: true, name: "rate_limit_window_unique" }),
    db.collection("mutation_rate_limits").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: "rate_limit_expiry" }),
  ]).then(() => undefined);
  indexesByDatabase.set(db, creation);
  try {
    await creation;
  } catch (error) {
    indexesByDatabase.delete(db);
    throw error;
  }
}

/** Close the shared pool when an integration runner or application worker shuts down. */
export async function closeDatabase(): Promise<void> {
  const pending = clientPromise;
  clientPromise = undefined;
  clientUri = undefined;
  if (pending) await (await pending).close();
}
