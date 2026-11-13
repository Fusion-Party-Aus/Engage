import type { ClientSession, Db } from "mongodb";
import { normalizeMatterType, type MatterTypeId } from "./matters.ts";
import { proposalBallotId } from "./vote-storage.ts";

export const BALLOT_SCHEMA_VERSION = 1;
export const BALLOTS_COLLECTION = "ballots";
export const FORMAL_DECISIONS_COLLECTION = "ballot_results";

export interface BallotElectorate {
  scope: "national" | "branch";
  branchId: string;
}

export interface BallotRecord {
  schemaVersion: number;
  ballotId: string;
  matterId: string;
  matterType: MatterTypeId;
  purpose: "matter_adoption" | "amendment" | "consultation" | string;
  revisionId: string;
  amendmentId?: string;
  electorate: BallotElectorate;
  governanceAuthorityBranchId: string;
  jurisdictionBranchId: string;
  status: "open" | "closed" | "certified" | "cancelled";
  closesAt?: Date;
  openedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface FormalDecisionRecord {
  decisionEventId: string;
  ballotId: string;
  proposalId: string;
  matterId: string;
  revisionId: string;
  result: "successful" | "unsuccessful" | "inconclusive";
  authorityBranchId?: string;
  recordedBy: string;
  recordedAt: Date;
}

export class BallotDomainError extends Error {
  status: number;
  code: string;

  constructor(message: string, status = 409, code = "BALLOT_DOMAIN_ERROR") {
    super(message);
    this.name = "BallotDomainError";
    this.status = status;
    this.code = code;
  }
}

export function resolveBallotElectorate(matter: {
  jurisdictionBranchId?: string;
  governanceAuthorityBranchId?: string;
  originatingBranchId?: string;
  publicationScope?: string;
}): BallotElectorate {
  const branchId = String(
    matter.jurisdictionBranchId ||
      matter.governanceAuthorityBranchId ||
      matter.originatingBranchId ||
      "branch-nat",
  );
  const scope =
    branchId === "branch-nat" || matter.publicationScope === "national"
      ? "national"
      : "branch";
  return { scope, branchId };
}

/**
 * Create or update a distinct ballot record for a matter and immutable revision.
 * Supports a 1-to-many matter -> ballots relationship while preserving legacy
 * `proposal:<proposalId>` ballot identities.
 */
export async function upsertMatterBallot(
  db: Db,
  input: {
    ballotId?: string;
    matterId: string;
    matterType?: string;
    purpose?: string;
    revisionId: string;
    amendmentId?: string;
    electorate?: BallotElectorate;
    governanceAuthorityBranchId?: string;
    jurisdictionBranchId?: string;
    status?: BallotRecord["status"];
    closesAt?: Date | null;
    now?: Date;
  },
  session?: ClientSession,
): Promise<BallotRecord> {
  const sessionOpts = session ? { session } : undefined;
  const matterId = input.matterId.trim();
  const revisionId = input.revisionId.trim();
  if (!matterId || !revisionId) {
    throw new BallotDomainError(
      "Matter ID and immutable revision ID are required for a ballot.",
      400,
      "MISSING_BALLOT_BINDING",
    );
  }

  const ballotId = (input.ballotId ?? proposalBallotId(matterId)).trim();
  const matterType = normalizeMatterType(input.matterType, matterId);
  const now = input.now ?? new Date();

  const existing = await db
    .collection(BALLOTS_COLLECTION)
    .findOne({ ballotId }, sessionOpts);

  if (existing && existing.revisionId && existing.revisionId !== revisionId) {
    throw new BallotDomainError(
      "Ballot is already bound to a different immutable wording revision.",
      409,
      "BALLOT_REVISION_CONFLICT",
    );
  }

  const electorate = input.electorate ?? {
    scope:
      !input.jurisdictionBranchId || input.jurisdictionBranchId === "branch-nat"
        ? "national"
        : "branch",
    branchId: input.jurisdictionBranchId || "branch-nat",
  };

  const record: BallotRecord = {
    schemaVersion: BALLOT_SCHEMA_VERSION,
    ballotId,
    matterId,
    matterType,
    purpose: input.purpose ?? (input.amendmentId ? "amendment" : "matter_adoption"),
    revisionId,
    ...(input.amendmentId ? { amendmentId: input.amendmentId } : {}),
    electorate,
    governanceAuthorityBranchId:
      input.governanceAuthorityBranchId ?? electorate.branchId,
    jurisdictionBranchId: input.jurisdictionBranchId ?? electorate.branchId,
    status: input.status ?? (existing?.status as BallotRecord["status"]) ?? "open",
    ...(input.closesAt ? { closesAt: input.closesAt } : {}),
    openedAt: existing?.openedAt ? new Date(existing.openedAt) : now,
    createdAt: existing?.createdAt ? new Date(existing.createdAt) : now,
    updatedAt: now,
  };

  await db.collection(BALLOTS_COLLECTION).updateOne(
    { ballotId },
    {
      $set: {
        schemaVersion: record.schemaVersion,
        matterId: record.matterId,
        matterType: record.matterType,
        purpose: record.purpose,
        revisionId: record.revisionId,
        ...(record.amendmentId ? { amendmentId: record.amendmentId } : {}),
        electorate: record.electorate,
        governanceAuthorityBranchId: record.governanceAuthorityBranchId,
        jurisdictionBranchId: record.jurisdictionBranchId,
        status: record.status,
        ...(record.closesAt ? { closesAt: record.closesAt } : {}),
        updatedAt: record.updatedAt,
      },
      $setOnInsert: {
        ballotId: record.ballotId,
        openedAt: record.openedAt,
        createdAt: record.createdAt,
      },
    },
    { upsert: true, ...(sessionOpts ?? {}) },
  );

  return record;
}

/**
 * List all ballots associated with a matter (1-to-many).
 * Seamlessly synthesises a compatible view for legacy proposals that do not
 * yet have a row in `ballots`.
 */
export async function listMatterBallots(
  db: Db,
  matterId: string,
): Promise<BallotRecord[]> {
  const [stored, proposal, amendments] = await Promise.all([
    db
      .collection(BALLOTS_COLLECTION)
      .find({ matterId })
      .sort({ createdAt: 1 })
      .toArray(),
    db.collection("proposals").findOne({ proposalId: matterId }),
    db.collection("amendments").find({ proposalId: matterId }).toArray(),
  ]);

  const byId = new Map<string, BallotRecord>();
  for (const row of stored) {
    byId.set(String(row.ballotId), {
      schemaVersion: Number(row.schemaVersion ?? BALLOT_SCHEMA_VERSION),
      ballotId: String(row.ballotId),
      matterId: String(row.matterId),
      matterType: normalizeMatterType(row.matterType, matterId),
      purpose: String(row.purpose ?? "matter_adoption"),
      revisionId: String(row.revisionId),
      ...(row.amendmentId ? { amendmentId: String(row.amendmentId) } : {}),
      electorate: row.electorate ?? {
        scope: "national",
        branchId: String(row.jurisdictionBranchId ?? "branch-nat"),
      },
      governanceAuthorityBranchId: String(
        row.governanceAuthorityBranchId ?? "branch-nat",
      ),
      jurisdictionBranchId: String(row.jurisdictionBranchId ?? "branch-nat"),
      status: (row.status as BallotRecord["status"]) ?? "open",
      ...(row.closesAt ? { closesAt: new Date(row.closesAt) } : {}),
      openedAt: row.openedAt ? new Date(row.openedAt) : new Date(),
      createdAt: row.createdAt ? new Date(row.createdAt) : new Date(),
      updatedAt: row.updatedAt ? new Date(row.updatedAt) : new Date(),
    });
  }

  const primaryBallotId = proposalBallotId(matterId);
  if (proposal?.ballotRevisionId && !byId.has(primaryBallotId)) {
    const electorate = resolveBallotElectorate(proposal);
    byId.set(primaryBallotId, {
      schemaVersion: BALLOT_SCHEMA_VERSION,
      ballotId: primaryBallotId,
      matterId,
      matterType: normalizeMatterType(proposal.kind, matterId),
      purpose: "matter_adoption",
      revisionId: String(proposal.ballotRevisionId),
      electorate,
      governanceAuthorityBranchId: String(
        proposal.governanceAuthorityBranchId ?? electorate.branchId,
      ),
      jurisdictionBranchId: String(
        proposal.jurisdictionBranchId ?? electorate.branchId,
      ),
      status: proposal.stage === "decide" ? "open" : "closed",
      ...(proposal.ballotClosesAt
        ? { closesAt: new Date(proposal.ballotClosesAt) }
        : {}),
      openedAt: proposal.updatedAt
        ? new Date(proposal.updatedAt)
        : new Date(),
      createdAt: proposal.createdAt
        ? new Date(proposal.createdAt)
        : new Date(),
      updatedAt: proposal.updatedAt
        ? new Date(proposal.updatedAt)
        : new Date(),
    });
  }

  for (const amendment of amendments) {
    if (!amendment.ballotAmendmentRevisionId) continue;
    const amdBallotId = `amendment:${amendment.amendmentId}`;
    if (byId.has(amdBallotId)) continue;
    const electorate = proposal
      ? resolveBallotElectorate(proposal)
      : { scope: "national" as const, branchId: "branch-nat" };
    byId.set(amdBallotId, {
      schemaVersion: BALLOT_SCHEMA_VERSION,
      ballotId: amdBallotId,
      matterId,
      matterType: proposal
        ? normalizeMatterType(proposal.kind, matterId)
        : "policy",
      purpose: "amendment",
      revisionId: String(
        amendment.ballotRevisionId ?? amendment.baseRevisionId ?? "",
      ),
      amendmentId: String(amendment.amendmentId),
      electorate,
      governanceAuthorityBranchId: electorate.branchId,
      jurisdictionBranchId: electorate.branchId,
      status: amendment.status === "voting" ? "open" : "closed",
      ...(amendment.ballotClosesAt
        ? { closesAt: new Date(amendment.ballotClosesAt) }
        : {}),
      openedAt: amendment.updatedAt
        ? new Date(amendment.updatedAt)
        : new Date(),
      createdAt: amendment.createdAt
        ? new Date(amendment.createdAt)
        : new Date(),
      updatedAt: amendment.updatedAt
        ? new Date(amendment.updatedAt)
        : new Date(),
    });
  }

  return [...byId.values()];
}

/**
 * Record an immutable formal decision for a specific ballot and wording revision.
 */
export async function recordFormalDecision(
  db: Db,
  input: {
    ballotId?: string;
    matterId: string;
    revisionId: string;
    result: "successful" | "unsuccessful" | "inconclusive";
    decisionEventId: string;
    authorityBranchId?: string;
    recordedBy: string;
    now?: Date;
  },
): Promise<FormalDecisionRecord> {
  const ballotId = (input.ballotId ?? proposalBallotId(input.matterId)).trim();
  const existing = await db.collection(FORMAL_DECISIONS_COLLECTION).findOne({
    $or: [{ ballotId }, { proposalId: input.matterId, ballotId: { $exists: false } }],
  });
  if (existing) {
    throw new BallotDomainError(
      "Ballot result is already recorded and cannot be replaced.",
      409,
      "DECISION_ALREADY_RECORDED",
    );
  }

  const now = input.now ?? new Date();
  const record: FormalDecisionRecord = {
    decisionEventId: input.decisionEventId,
    ballotId,
    proposalId: input.matterId,
    matterId: input.matterId,
    revisionId: input.revisionId,
    result: input.result,
    ...(input.authorityBranchId
      ? { authorityBranchId: input.authorityBranchId }
      : {}),
    recordedBy: input.recordedBy,
    recordedAt: now,
  };

  await db.collection(FORMAL_DECISIONS_COLLECTION).insertOne(record);
  await db.collection(BALLOTS_COLLECTION).updateOne(
    { ballotId },
    { $set: { status: "certified", updatedAt: now } },
  );

  return record;
}
