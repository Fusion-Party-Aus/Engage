import { ensureIndexes, getDatabase } from "../../../lib/platform/database";
import { platformRoles, resolveIdentity } from "../../../lib/platform/auth";
import { json, platformEnv } from "../../../lib/platform/http";
import type { RuntimeLocals } from "../../../lib/platform/types";
import { consumeRateLimit } from "../../../lib/platform/rate-limit";

export const prerender = false;

export async function GET({ request, locals }: { request: Request; locals: RuntimeLocals }): Promise<Response> {
  const env = platformEnv(locals);
  const { identity } = await resolveIdentity(request, env);
  if (!identity) return json({ error: "Sign in with an authorised administrator account." }, 401);
  try {
    const db = await getDatabase(env);
    await ensureIndexes(db);
    if (!(await platformRoles(identity, env)).includes("administrator")) return json({ error: "Administrator role required." }, 403);
    if (!(await consumeRateLimit(db, "admin-audit", identity.memberId, 60, 60_000))) return json({ error: "Too many audit requests. Please try again shortly." }, 429, { "retry-after": "60" });
    const requested = Number(new URL(request.url).searchParams.get("limit") ?? 50);
    const limit = Number.isFinite(requested) ? Math.min(100, Math.max(1, Math.floor(requested))) : 50;
    const records = await db.collection("operational_audit").find({}, {
      projection: {
        _id: 0, actorId: 1, actorSource: 1, action: 1, targetType: 1, targetId: 1,
        status: 1, closedCount: 1, createdAt: 1,
      },
    }).sort({ createdAt: -1 }).limit(limit).toArray();
    const events = records.map((record) => {
      const { actorId, ...safeRecord } = record;
      // Vote audit retains a tamper-evident action/time trail without making the named member-to-ballot link casual to inspect.
      return typeof record.action === "string" && record.action.includes("vote") ? safeRecord : record;
    });
    return json({ events, syntheticOnly: identity.source === "synthetic" });
  } catch {
    return json({ error: "Audit records are temporarily unavailable." }, 503);
  }
}
