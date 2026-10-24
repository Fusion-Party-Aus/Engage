import { ensureIndexes, getDatabase } from "../../lib/platform/database";
import { resolveIdentity } from "../../lib/platform/auth";
import { castPreviewVote, type BallotRecord } from "../../lib/platform/ballots";
import { json, platformEnv, readJson, requireSameOrigin } from "../../lib/platform/http";
import { formalVotingIsEnabled } from "../../lib/platform/voting.mjs";
import { consumeRateLimit } from "../../lib/platform/rate-limit";
import type { RuntimeLocals, VoteChoice } from "../../lib/platform/types";

export const prerender = false;

export async function POST({ request, locals }: { request: Request; locals: RuntimeLocals }): Promise<Response> {
  const originError = requireSameOrigin(request);
  if (originError) return originError;
  const env = platformEnv(locals);
  const resolution = await resolveIdentity(request, env);
  if (!resolution.identity) return json({ error: resolution.unavailableReason ? "Underground sign-in and eligibility verification are not available yet." : "Sign in to participate." }, resolution.unavailableReason ? 503 : 401);
  const body = await readJson(request);
  if (!body || typeof body.ballotId !== "string" || (body.choice !== "approve" && body.choice !== "do-not-approve")) return json({ error: "Choose a ballot and either Approve or Do Not Approve." }, 400);
  if (resolution.identity.source !== "synthetic" || env.APP_MODE !== "preview") {
    if (!formalVotingIsEnabled(env)) return json({ error: "Binding ballots are disabled until the Underground identity and governance release gates are complete." }, 423);
    return json({ error: "Production eligibility verification is unavailable." }, 503);
  }
  try {
    const db = await getDatabase(env);
    await ensureIndexes(db);
    if (!(await consumeRateLimit(db, "preview-vote", resolution.identity.memberId, 30, 60_000))) return json({ error: "Too many vote changes in a short time. Please try again shortly." }, 429, { "retry-after": "60" });
    const ballot = await db.collection<BallotRecord>("ballots").findOne({ ballotId: body.ballotId, mode: "simulation" });
    if (!ballot) return json({ error: "Synthetic simulation ballot not found." }, 404);
    await castPreviewVote(db, resolution.identity, ballot, body.choice as VoteChoice, env);
    return json({ recorded: true, synthetic: true, receipt: { ballotId: ballot.ballotId, memberId: resolution.identity.memberId, receivedAt: new Date().toISOString() } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Your demonstration vote could not be recorded.";
    const status = message.includes("not open") ? 409 : message.includes("Choose") ? 400 : 503;
    return json({ error: message }, status);
  }
}
