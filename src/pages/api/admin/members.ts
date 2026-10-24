import { platformRoles, resolveIdentity } from "../../../lib/platform/auth.ts";
import { ensureIndexes, getDatabase } from "../../../lib/platform/database.ts";
import { changeMembership, membershipStatus } from "../../../lib/platform/membership.ts";
import { json, platformEnv, readJson, requireSameOrigin } from "../../../lib/platform/http.ts";
import type { RuntimeLocals } from "../../../lib/platform/types.ts";
export const prerender = false;
type Context = { request: Request; locals: RuntimeLocals };
export async function GET({ request, locals }: Context) {
  const env = platformEnv(locals);
  const { identity } = await resolveIdentity(request, env);
  if (!identity) return json({ error: "Sign in." }, 401);
  if (identity.source !== "engage" || !(await platformRoles(identity, env)).includes("administrator")) return json({ error: "Administrator role required." }, 403);
  const db = await getDatabase(env);
  const cursor = new URL(request.url).searchParams.get("after");
  if (cursor && !/^[a-f0-9]{24}$/.test(cursor)) return json({ error: "Invalid account cursor." }, 400);
  const { ObjectId } = await import("mongodb");
  const users = await db.collection("user").find(cursor ? { _id: { $gt: new ObjectId(cursor) } } : {}, { projection: { name: 1, email: 1, createdAt: 1 } }).sort({ _id: 1 }).limit(50).toArray();
  const accounts = await Promise.all(users.map(async (user) => ({ memberId: user._id.toString(), name: user.name, email: user.email, status: await membershipStatus(db, user._id.toString()) })));
  return json({ accounts, next: users.length === 50 ? users.at(-1)!._id.toString() : null });
}
export async function PATCH({ request, locals }: Context) {
  const originError = requireSameOrigin(request); if (originError) return originError;
  const env = platformEnv(locals);
  const { identity } = await resolveIdentity(request, env);
  if (!identity) return json({ error: "Sign in." }, 401);
  if (identity.source !== "engage" || !(await platformRoles(identity, env)).includes("administrator")) return json({ error: "Administrator role required." }, 403);
  const body = await readJson(request);
  if (!body || typeof body.memberId !== "string" || !["pending", "verified", "suspended"].includes(String(body.status))) return json({ error: "Choose an account and verification status." }, 400);
  try {
    const db = await getDatabase(env); await ensureIndexes(db);
    await changeMembership(db, identity, body.memberId, body.status as "pending" | "verified" | "suspended");
    return json({ updated: true });
  } catch (error) { return json({ error: error instanceof Error ? error.message : "Verification could not be saved." }, 400); }
}
