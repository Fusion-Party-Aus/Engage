import { ensureIndexes, getDatabase } from "../../../../lib/platform/database";
import { closeExpiredBallots, getBallotResults, type BallotRecord } from "../../../../lib/platform/ballots";
import { json, platformEnv } from "../../../../lib/platform/http";
import type { RuntimeLocals } from "../../../../lib/platform/types";

export const prerender = false;

export async function GET({ params, locals }: { params: { ballotId: string }; locals: RuntimeLocals }): Promise<Response> {
  try {
    const db = await getDatabase(platformEnv(locals));
    await ensureIndexes(db);
    await closeExpiredBallots(db);
    const ballot = await db.collection<BallotRecord>("ballots").findOne({ ballotId: params.ballotId });
    if (!ballot) return json({ error: "Ballot not found." }, 404);
    const results = await getBallotResults(db, ballot);
    if (!results) return json({ error: "Results will be available after the ballot closes." }, 409);
    return json({ results, ballotId: ballot.ballotId, proposalId: ballot.proposalId, policyRevisionId: ballot.policyRevisionId });
  } catch {
    return json({ error: "Results are temporarily unavailable." }, 503);
  }
}
