import { BSON, type Db, type Document } from "mongodb";

// Current CRUD decisions are one ballot per proposal. Legacy formal/consultation
// ballots remain in votes, with their original identities and uniqueness index.
export const PROPOSAL_VOTES = "proposal_votes";
export const VOTE_MIGRATION = "proposal-votes-v1";
export const VOTE_INDEX = "one_current_proposal_vote_per_member_ballot";
export const proposalBallotId = (proposalId: string) => `proposal:${proposalId}`;

export async function ensureProposalVoteIndex(db: Db): Promise<void> {
  await db.collection(PROPOSAL_VOTES).createIndex(
    { ballotId: 1, memberId: 1 }, { unique: true, name: VOTE_INDEX },
  );
}

export async function ensureVoteStorage(db: Db): Promise<void> {
  if (await db.collection("votes").countDocuments() &&
      !await db.collection("schema_migrations").findOne({ _id: VOTE_MIGRATION } as Document)) {
    throw new Error("Vote storage migration required. Run scripts/migrate-proposal-votes.mjs in dry-run mode first.");
  }
  // Never swallow failures of a voting uniqueness protection.
  await ensureProposalVoteIndex(db);
}

const nonempty = (s: unknown): s is string => typeof s === "string" && s.length > 0 && s.trim() === s;
const same = (a: Document, b: Document) => {
  const sorted = (d: Document) => Object.fromEntries(Object.entries(d).sort(([a], [b]) => a.localeCompare(b)));
  return BSON.EJSON.stringify(sorted(a)) === BSON.EJSON.stringify(sorted(b));
};

export async function inspectVoteMigration(db: Db) {
  const source = await db.collection("votes").find({}).toArray();
  const destination = await db.collection(PROPOSAL_VOTES).find({}).toArray();
  const proposals = new Set((await db.collection("proposals").find({}).toArray()).map(p => p.proposalId));
  const completed = Boolean(await db.collection("schema_migrations").findOne({ _id: VOTE_MIGRATION } as Document));
  const errors: string[] = [];
  const copies: Document[] = [];
  const seen = new Set<string>();
  let legacyBallots = 0;
  for (const v of source) {
    if (nonempty(v.ballotId)) { legacyBallots++; continue; }
    if (v.ballotId != null || !nonempty(v.proposalId) || !nonempty(v.memberId) ||
        !["approve", "abstain", "reject"].includes(v.choice) || !(v.updatedAt instanceof Date) ||
        (v.policyId != null && v.policyId !== v.proposalId) || !proposals.has(v.proposalId)) {
      errors.push("Unrecognised or orphaned source vote; manual review required."); continue;
    }
    const key = JSON.stringify([v.proposalId, v.memberId]);
    if (seen.has(key)) errors.push("Duplicate source proposal/member vote; no winner selected automatically.");
    seen.add(key);
    copies.push({ ...v, ballotId: proposalBallotId(v.proposalId) });
  }
  for (const v of destination) {
    if (!nonempty(v.proposalId) || v.ballotId !== proposalBallotId(v.proposalId) ||
        !nonempty(v.memberId) || !["approve", "abstain", "reject"].includes(v.choice)) {
      errors.push("Unrecognised destination vote; manual review required.");
    }
    if (!completed) {
      const expected = copies.find(c => String(c._id) === String(v._id));
      if (!expected || !same(expected, v)) errors.push("Destination differs from source; migration will not overwrite it.");
    }
  }
  return { sourceCount: source.length, legacyBallots, currentVotes: copies.length,
    destinationCount: destination.length, completed, errors, copies };
}

export async function migrateProposalVotes(db: Db, apply = false) {
  const plan = await inspectVoteMigration(db);
  if (plan.errors.length) throw new Error(plan.errors.join("\n"));
  if (!apply) return plan;
  await ensureProposalVoteIndex(db); // Build replacement protection BEFORE copying.
  if (plan.completed) return plan;
  for (const record of plan.copies) {
    await db.collection(PROPOSAL_VOTES).updateOne(
      { _id: record._id }, { $setOnInsert: record }, { upsert: true },
    );
  }
  const verified = await inspectVoteMigration(db);
  if (verified.errors.length || verified.destinationCount !== verified.currentVotes) {
    throw new Error("Migration verification failed; completion marker not written.");
  }
  await db.collection("schema_migrations").updateOne(
    { _id: VOTE_MIGRATION } as Document,
    { $setOnInsert: { completedAt: new Date(), sourceCount: plan.sourceCount, copiedCount: plan.currentVotes } },
    { upsert: true },
  );
  return { ...verified, completed: true };
}
