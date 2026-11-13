import { randomUUID } from "node:crypto";
import type { Db } from "mongodb";
import { DEFAULT_STATE_SITES } from "./site-config.ts";
import {
  BRANCH_MEMBERSHIPS,
  BRANCH_SUBSCRIPTIONS,
  migrateBranchParticipation,
} from "./branch-participation.ts";
import {
  OPEN_BALLOT_EXPIRY_MIGRATION,
  applyOpenBallotExpiryMigration,
  previewOpenBallotExpiryMigration,
  type BallotExpiryMigrationReport,
} from "./ballot-expiry-migration.ts";

/**
 * Durable, restartable database migrations for the administration workspace.
 * Every run is recorded in `data_migrations`; the operations themselves are
 * idempotent so an interrupted run can be safely retried from the same page.
 */

export const MIGRATIONS_COLLECTION = "data_migrations";
export const STANDARD_BRANCHES_MIGRATION = "standard-branches";
export const BRANCH_PARTICIPATION_MIGRATION = "branch-participation";

export { OPEN_BALLOT_EXPIRY_MIGRATION };
export type MigrationId =
  | typeof STANDARD_BRANCHES_MIGRATION
  | typeof BRANCH_PARTICIPATION_MIGRATION
  | typeof OPEN_BALLOT_EXPIRY_MIGRATION;

export interface StandardBranchDefinition {
  branchId: string;
  name: string;
  kind: "national" | "state" | "territory";
  parentBranchId: string | null;
  recognised: true;
  websiteHref: string;
}

const NATIONAL_BRANCH_ID = "branch-nat";

function standardBranchName(code: string, name: string): string {
  if (code === "NAT") return "Fusion National";
  return `Fusion ${name}`;
}

export const STANDARD_BRANCHES: StandardBranchDefinition[] = DEFAULT_STATE_SITES.map(
  (site) => {
    const national = site.code === "NAT";
    const territory = site.code === "ACT" || site.code === "NT";
    return {
      branchId: `branch-${site.code.toLowerCase()}`,
      name: standardBranchName(site.code, site.name),
      kind: national ? "national" : territory ? "territory" : "state",
      parentBranchId: national ? null : NATIONAL_BRANCH_ID,
      recognised: true,
      websiteHref: site.websiteHref,
    };
  },
);

export interface StandardBranchPreview {
  total: number;
  existing: number;
  missing: number;
  missingNames: string[];
}

export async function previewStandardBranches(
  db: Db,
): Promise<StandardBranchPreview> {
  const rows = await db.collection("branches").find({}).toArray();
  const missing = STANDARD_BRANCHES.filter(branch => !matchingStandardBranch(rows,branch));
  const existing = new Set(STANDARD_BRANCHES.filter(branch => matchingStandardBranch(rows,branch)).map(b=>b.branchId));
  return {
    total: STANDARD_BRANCHES.length,
    existing: existing.size,
    missing: missing.length,
    missingNames: missing.map((branch) => branch.name),
  };
}

function matchingStandardBranch(rows: Record<string, any>[], branch: StandardBranchDefinition) {
  const candidates=rows.filter(row=>row.branchId===branch.branchId || (row.kind===branch.kind && String(row.name).trim().toLowerCase()===branch.name.toLowerCase()));
  if(candidates.length>1) throw new Error(`Duplicate ${branch.name} branches need reconciliation before this migration can continue.`);
  return candidates[0];
}

/**
 * Add the standard national, state and territory branches if they are missing.
 * Existing branches are never renamed, re-parented or un-recognised.
 */
export async function seedStandardBranches(db: Db): Promise<{
  created: number;
  existing: number;
  total: number;
}> {
  let created = 0;
  let existing = 0;
  const now = new Date();
  const rows=await db.collection("branches").find({}).toArray();
  // Resolve all identities before writing; ambiguous existing branches fail closed.
  const matches=new Map(STANDARD_BRANCHES.map(branch=>[branch.branchId,matchingStandardBranch(rows,branch)]));
  const nationalId=String(matches.get("branch-nat")?.branchId ?? "branch-nat");
  for (const branch of STANDARD_BRANCHES) {
    if(matches.get(branch.branchId)) { existing++; continue; }
    try {
      const result = await db.collection("branches").updateOne(
        { branchId: branch.branchId },
        {
          $setOnInsert: {
            branchId: branch.branchId,
            name: branch.name,
            kind: branch.kind,
            ...(branch.parentBranchId
              ? { parentBranchId: nationalId }
              : {}),
            recognised: true,
            websiteHref: branch.websiteHref,
            seededBy: `migration:${STANDARD_BRANCHES_MIGRATION}`,
            createdAt: now,
            updatedAt: now,
          },
        },
        { upsert: true },
      );
      if (
        (result as { upsertedId?: unknown }).upsertedId ||
        (result as { upsertedCount?: number }).upsertedCount
      ) {
        created += 1;
      } else {
        existing += 1;
      }
    } catch (error) {
      if ((error as { code?: number }).code === 11000) {
        existing += 1;
        continue;
      }
      throw error;
    }
  }
  return { created, existing, total: STANDARD_BRANCHES.length };
}

export interface BranchParticipationPreview {
  annotatedMemberships: number;
  createdSubscriptions: number;
  preservedMemberships: number;
  assignedProposals: number;
  openProposals: number;
}

async function previewBranchParticipation(
  db: Db,
): Promise<BranchParticipationPreview> {
  const result = await migrateBranchParticipation(db, { apply: false });
  return {
    annotatedMemberships: result.annotatedMemberships,
    createdSubscriptions: result.createdSubscriptions,
    preservedMemberships: result.preservedMemberships,
    assignedProposals: result.assignedProposals,
    openProposals: await db.collection("proposals").countDocuments({
      stage: { $in: ["propose", "deliberate", "decide"] },
    }),
  };
}

export type MigrationRunStatus =
  | "pending"
  | "blocked"
  | "running"
  | "completed"
  | "failed";

export interface MigrationRunRecord {
  status: MigrationRunStatus;
  lastStartedAt?: string;
  lastCompletedAt?: string;
  lastResult?: Record<string, number | boolean | string>;
  lastError?: string;
  runCount: number;
}

export interface MigrationStatus {
  id: MigrationId;
  title: string;
  description: string;
  status: MigrationRunStatus;
  ready: boolean;
  requires?: MigrationId[];
  preview:
    | { kind: "branches"; data: StandardBranchPreview }
    | { kind: "participation"; data: BranchParticipationPreview }
    | { kind: "ballot-expiry"; data: BallotExpiryMigrationReport };
  lastRun?: MigrationRunRecord;
}

function serializeRun(row: Record<string, any> | null | undefined): MigrationRunRecord | undefined {
  if (!row) return undefined;
  return {
    status: row.status ?? "pending",
    lastStartedAt: row.lastStartedAt ? new Date(row.lastStartedAt).toISOString() : undefined,
    lastCompletedAt: row.lastCompletedAt ? new Date(row.lastCompletedAt).toISOString() : undefined,
    lastResult:
      row.lastResult && typeof row.lastResult === "object"
        ? row.lastResult
        : undefined,
    lastError: row.lastError ? String(row.lastError) : undefined,
    runCount: Number(row.runCount ?? 0),
  };
}

export async function getMigrationStatus(db: Db): Promise<MigrationStatus[]> {
  const [branchPreview, participationPreview, ballotExpiryPreview, records] =
    await Promise.all([
      previewStandardBranches(db),
      previewBranchParticipation(db),
      previewOpenBallotExpiryMigration(db),
      db
        .collection(MIGRATIONS_COLLECTION)
        .find({
          migrationId: {
            $in: [
              STANDARD_BRANCHES_MIGRATION,
              BRANCH_PARTICIPATION_MIGRATION,
              OPEN_BALLOT_EXPIRY_MIGRATION,
            ],
          },
        })
        .toArray(),
    ]);
  const byId = new Map(
    records.map((row: any) => [String(row.migrationId), row]),
  );
  const branchRecord = serializeRun(byId.get(STANDARD_BRANCHES_MIGRATION));
  const participationRecord = serializeRun(
    byId.get(BRANCH_PARTICIPATION_MIGRATION),
  );
  const ballotExpiryRecord = serializeRun(
    byId.get(OPEN_BALLOT_EXPIRY_MIGRATION),
  );
  const branchesMissing = branchPreview.missing > 0;
  const participationOutstanding =
    participationPreview.annotatedMemberships > 0 ||
    participationPreview.createdSubscriptions > 0 ||
    participationPreview.assignedProposals > 0;
  const ballotExpiryOutstanding = ballotExpiryPreview.counts.eligible > 0;

  const branchStatus: MigrationRunStatus =
    branchRecord?.status === "running"
      ? "running"
      : branchesMissing
        ? branchRecord?.status === "failed"
          ? "failed"
          : "pending"
        : "completed";

  let participationStatus: MigrationRunStatus;
  if (branchesMissing) participationStatus = "blocked";
  else if (participationRecord?.status === "running") participationStatus = "running";
  else if (participationRecord?.status === "failed") participationStatus = "failed";
  else if (participationOutstanding) participationStatus = "pending";
  else participationStatus = "completed";

  let ballotExpiryStatus: MigrationRunStatus;
  if (ballotExpiryRecord?.status === "running") ballotExpiryStatus = "running";
  else if (ballotExpiryRecord?.status === "failed") ballotExpiryStatus = "failed";
  else if (ballotExpiryOutstanding) ballotExpiryStatus = "pending";
  else ballotExpiryStatus = "completed";

  return [
    {
      id: STANDARD_BRANCHES_MIGRATION,
      title: "Standard branches",
      description:
        "Adds Fusion National and the state and territory branches when they are missing. Existing branches are never renamed or re-parented.",
      status: branchStatus,
      ready: branchStatus === "pending" || branchStatus === "failed",
      preview: { kind: "branches", data: branchPreview },
      lastRun: branchRecord,
    },
    {
      id: BRANCH_PARTICIPATION_MIGRATION,
      title: "Branch participation",
      description:
        "Preserves existing verified memberships, adds branch-following preferences for them, and gives open proposals without a branch context national governance scope. Votes, ballot revisions and archived decisions are not changed.",
      status: participationStatus,
      ready: participationStatus === "pending" || participationStatus === "failed",
      requires: branchesMissing ? [STANDARD_BRANCHES_MIGRATION] : [],
      preview: { kind: "participation", data: participationPreview },
      lastRun: participationRecord,
    },
    {
      id: OPEN_BALLOT_EXPIRY_MIGRATION,
      title: "Open ballot expiry (14 January 2027)",
      description:
        "Assigns Thursday, 14 January 2027 at 11:59 pm AEDT (Australia/Melbourne) to open formal ballots without an existing closing date. Preserves existing configured deadlines, closed/archived ballots, revisions, and votes.",
      status: ballotExpiryStatus,
      ready: ballotExpiryStatus === "pending" || ballotExpiryStatus === "failed",
      preview: { kind: "ballot-expiry", data: ballotExpiryPreview },
      lastRun: ballotExpiryRecord,
    },
  ];
}

function assertMigrationId(value: unknown): MigrationId {
  if (
    value !== STANDARD_BRANCHES_MIGRATION &&
    value !== BRANCH_PARTICIPATION_MIGRATION &&
    value !== OPEN_BALLOT_EXPIRY_MIGRATION
  ) {
    throw new MigrationError("Choose a database migration to run.", 400);
  }
  return value;
}

export class MigrationError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "MigrationError";
    this.status = status;
  }
}

async function markRunning(db: Db, migrationId: MigrationId, actorId: string) {
  const now = new Date();
  const existing = await db
    .collection(MIGRATIONS_COLLECTION)
    .findOne({ migrationId });
  const runCount = Number(existing?.runCount ?? 0) + 1;
  await db.collection(MIGRATIONS_COLLECTION).updateOne(
    { migrationId },
    {
      $set: {
        migrationId,
        status: "running",
        lastRunId: randomUUID(),
        lastStartedAt: now,
        lastActorId: actorId,
        runCount,
        updatedAt: now,
      },
      $unset: { lastError: "" },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true },
  );
}

async function markFinished(
  db: Db,
  migrationId: MigrationId,
  status: "completed" | "failed",
  result?: Record<string, number | boolean | string>,
  error?: string,
) {
  const now = new Date();
  await db.collection(MIGRATIONS_COLLECTION).updateOne(
    { migrationId },
    {
      $set: {
        migrationId,
        status,
        lastCompletedAt: now,
        lastResult: result ?? null,
        lastError: error ? error.slice(0, 500) : null,
        updatedAt: now,
      },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true },
  );
}

export interface MigrationRunResult {
  migrationId: MigrationId;
  status: "completed";
  result: Record<string, number | boolean | string>;
}

export async function runMigration(
  db: Db,
  migrationIdInput: unknown,
  actorId: string,
): Promise<MigrationRunResult> {
  const migrationId = assertMigrationId(migrationIdInput);
  const status = await getMigrationStatus(db);
  const current = status.find((item) => item.id === migrationId);
  if (current?.status === "blocked") {
    throw new MigrationError(
      "Add the standard branches before running the branch participation migration.",
      409,
    );
  }

  await markRunning(db, migrationId, actorId);
  try {
    const result =
      migrationId === STANDARD_BRANCHES_MIGRATION
        ? await seedStandardBranches(db)
        : migrationId === BRANCH_PARTICIPATION_MIGRATION
          ? await migrateBranchParticipation(db)
          : (await applyOpenBallotExpiryMigration(db, { actorId, dryRun: false })).counts;
    const serializable: Record<string, number | boolean | string> = {
      ...Object.fromEntries(
        Object.entries(result).map(([key, value]) => [
          key,
          typeof value === "number" || typeof value === "boolean"
            ? value
            : String(value),
        ]),
      ),
    };
    await markFinished(db, migrationId, "completed", serializable);
    return { migrationId, status: "completed", result: serializable };
  } catch (error) {
    await markFinished(
      db,
      migrationId,
      "failed",
      undefined,
      error instanceof Error ? error.message : "Migration failed.",
    );
    throw error;
  }
}

/**
 * Run the ordered migrations from the admin page. Standard branches run first so
 * the National record exists before participation facts are interpreted.
 */
export async function runAllMigrations(
  db: Db,
  actorId: string,
): Promise<MigrationRunResult[]> {
  const results: MigrationRunResult[] = [];
  results.push(
    await runMigration(db, STANDARD_BRANCHES_MIGRATION, actorId),
  );
  results.push(
    await runMigration(db, BRANCH_PARTICIPATION_MIGRATION, actorId),
  );
  results.push(
    await runMigration(db, OPEN_BALLOT_EXPIRY_MIGRATION, actorId),
  );
  return results;
}
