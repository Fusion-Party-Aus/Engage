import { ensureIndexes, getDatabase } from "../../../lib/platform/database";
import { platformRoles, resolveIdentity } from "../../../lib/platform/auth";
import { json, platformEnv } from "../../../lib/platform/http";
import type { RuntimeLocals } from "../../../lib/platform/types";
import { consumeRateLimit } from "../../../lib/platform/rate-limit";
import type { Collection, Document } from "mongodb";

export const prerender = false;

async function countsBy(dbCollection: Collection<Document>) {
  const rows = await dbCollection.aggregate<{ _id: string; count: number }>([
    { $group: { _id: "$status", count: { $sum: 1 } } },
  ]).toArray();
  return Object.fromEntries(rows.map(({ _id, count }) => [_id || "unspecified", count]));
}

export async function GET({ request, locals }: { request: Request; locals: RuntimeLocals }): Promise<Response> {
  const env = platformEnv(locals);
  const { identity } = await resolveIdentity(request, env);
  if (!identity) return json({ error: "Sign in with an authorised administrator account." }, 401);
  try {
    const db = await getDatabase(env);
    await ensureIndexes(db);
    if (!(await platformRoles(identity, env)).includes("administrator")) return json({ error: "Administrator role required." }, 403);
    if (!(await consumeRateLimit(db, "admin-health", identity.memberId, 60, 60_000))) return json({ error: "Too many health checks. Please try again shortly." }, 429, { "retry-after": "60" });
    const [ballotStatus, submissionStatus, roundStatus, currentVotes, auditEvents] = await Promise.all([
      countsBy(db.collection("ballots")),
      countsBy(db.collection("consultation_submissions")),
      countsBy(db.collection("consultation_rounds")),
      db.collection("votes").countDocuments({}),
      db.collection("operational_audit").countDocuments({}),
    ]);
    return json({
      health: "available",
      counts: { ballotStatus, submissionStatus, roundStatus, currentVotes, currentFormalVotes: currentVotes, auditEvents },
      gates: { undergroundIdentity: "unavailable", bindingBallotsEnabled: false },
      syntheticOnly: identity.source === "synthetic",
    });
  } catch {
    return json({ health: "unavailable", error: "Operational counts are temporarily unavailable." }, 503);
  }
}
