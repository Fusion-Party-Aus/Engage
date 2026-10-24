import { ensureIndexes, getDatabase } from "../../../../lib/platform/database";
import { resolveIdentity } from "../../../../lib/platform/auth";
import { json, platformEnv } from "../../../../lib/platform/http";
import type { RuntimeLocals } from "../../../../lib/platform/types";

export const prerender = false;

export async function GET({ request, params, locals }: { request: Request; params: { ballotId: string }; locals: RuntimeLocals }): Promise<Response> {
  const env = platformEnv(locals);
  const resolution = await resolveIdentity(request, env);
  if (!resolution.identity) return json({ error: resolution.unavailableReason ? "Underground sign-in and eligibility verification are not available yet." : "Sign in to view your participation." }, resolution.unavailableReason ? 503 : 401);
  try {
    const db = await getDatabase(env);
    await ensureIndexes(db);
    const ballot = await db.collection("ballots").findOne({ ballotId: params.ballotId }, { projection: { _id: 0, ballotId: 1, mode: 1 } });
    if (!ballot) return json({ error: "Ballot not found." }, 404);
    const collection = resolution.identity.source === "synthetic" ? "preview_votes" : "votes";
    const vote = await db.collection(collection).findOne({ ballotId: params.ballotId, memberId: resolution.identity.memberId }, { projection: { _id: 1 } });
    return json({ participated: Boolean(vote), synthetic: resolution.identity.source === "synthetic" });
  } catch {
    return json({ error: "Participation status is temporarily unavailable." }, 503);
  }
}
