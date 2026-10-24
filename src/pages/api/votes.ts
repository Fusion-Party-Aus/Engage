import { ensureIndexes, getDatabase } from "../../lib/platform/database.ts";
import { resolveIdentity } from "../../lib/platform/auth.ts";
import { castVote, type BallotRecord } from "../../lib/platform/ballots.ts";
import { json, platformEnv, readJson, requireSameOrigin } from "../../lib/platform/http.ts";
import { formalVotingIsEnabled } from "../../lib/platform/voting.mjs";
import { consumeRateLimit } from "../../lib/platform/rate-limit.ts";
import type { RuntimeLocals, VoteChoice } from "../../lib/platform/types.ts";

export const prerender = false;

export async function POST({ request, locals }: { request: Request; locals: RuntimeLocals }): Promise<Response> {
  const originError = requireSameOrigin(request);
  if (originError) return originError;
  const env = platformEnv(locals);
  const resolution = await resolveIdentity(request, env);
  if (!resolution.identity) return json({ error: "Sign in to participate." }, 401);
  const body = await readJson(request);
  if (!body || typeof body.ballotId !== "string" || (body.choice !== "approve" && body.choice !== "do-not-approve")) return json({ error: "Choose a ballot and either Approve or Do Not Approve." }, 400);
  if (env.APP_MODE !== "preview") {
    if (!formalVotingIsEnabled(env)) return json({ error: "Binding ballots require governance authorisation." }, 423);
    if (resolution.identity.source !== "engage") return json({ error: "Production participation requires an Engage account." }, 403);
  }
  try {
    const db = await getDatabase(env);
    await ensureIndexes(db);
    if (!(await consumeRateLimit(db, "ballot-vote", resolution.identity.memberId, 30, 60_000))) return json({ error: "Too many vote changes in a short time. Please try again shortly." }, 429, { "retry-after": "60" });
    const ballot = await db.collection<BallotRecord>("ballots").findOne({ ballotId: body.ballotId });
    if (!ballot) return json({ error: "Ballot not found." }, 404);
    await castVote(db, resolution.identity, ballot, body.choice as VoteChoice, env);
    return json({ recorded: true, binding: formalVotingIsEnabled(env), receipt: { ballotId: ballot.ballotId, memberId: resolution.identity.memberId, receivedAt: new Date().toISOString() } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Your vote could not be recorded.";
    const status = message.includes("eligibility") || message.includes("identity") || message.includes("authorised") ? 403 : message.includes("not open") ? 409 : message.includes("Choose") ? 400 : message.includes("disabled") ? 423 : 503;
    return json({ error: message }, status);
  }
}
