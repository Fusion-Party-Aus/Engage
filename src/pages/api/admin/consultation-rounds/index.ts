import { ensureIndexes, getDatabase } from "../../../../lib/platform/database";
import { platformRoles, resolveIdentity } from "../../../../lib/platform/auth";
import { validPolicyId } from "../../../../lib/platform/policy-revisions.mjs";
import { json, platformEnv, readJson, requireSameOrigin } from "../../../../lib/platform/http";
import { consumeRateLimit } from "../../../../lib/platform/rate-limit";
import type { RuntimeLocals } from "../../../../lib/platform/types";

export const prerender = false;

export async function GET({ locals }: { locals: RuntimeLocals }): Promise<Response> {
  try {
    const db = await getDatabase(platformEnv(locals));
    await ensureIndexes(db);
    const rounds = await db.collection("consultation_rounds").find({}, {
      projection: {
        _id: 0, roundId: 1, program: 1, label: 1, status: 1, opensAt: 1, closesAt: 1,
        policyIds: 1, meeting: 1, timezone: 1,
      },
    }).sort({ opensAt: -1 }).limit(50).toArray();
    return json({ rounds });
  } catch {
    return json({ error: "Consultation rounds are temporarily unavailable." }, 503);
  }
}

export async function POST({ request, locals }: { request: Request; locals: RuntimeLocals }): Promise<Response> {
  const originError = requireSameOrigin(request);
  if (originError) return originError;
  const env = platformEnv(locals);
  const { identity } = await resolveIdentity(request, env);
  if (!identity) return json({ error: "Sign in with an authorised administrator account." }, 401);
  const body = await readJson(request);
  if (!body) return json({ error: "Provide a valid JSON consultation round." }, 400);
  const roundId = typeof body.roundId === "string" ? body.roundId.trim() : "";
  const program = typeof body.program === "string" ? body.program.trim() : "";
  const status = body.status === "open" && env.APP_MODE === "preview" ? "open" : "draft";
  const opensAt = typeof body.opensAt === "string" ? new Date(body.opensAt) : null;
  const closesAt = typeof body.closesAt === "string" ? new Date(body.closesAt) : null;
  const policyIds = Array.isArray(body.policyIds) ? body.policyIds.filter((id): id is string => validPolicyId(id)) : [];

  if (!/^[a-z0-9][a-z0-9-]{2,79}$/.test(roundId) || program.length < 3 || program.length > 200) {
    return json({ error: "Provide a valid roundId (lowercase letters, numbers, hyphens) and program title." }, 400);
  }
  if (!opensAt || !closesAt || Number.isNaN(opensAt.getTime()) || Number.isNaN(closesAt.getTime()) || closesAt <= opensAt) {
    return json({ error: "Provide valid ordered opening and closing dates." }, 400);
  }
  if (!policyIds.length) {
    return json({ error: "Include at least one policyId in the consultation round." }, 400);
  }

  try {
    const db = await getDatabase(env);
    await ensureIndexes(db);
    if (!(await platformRoles(identity, env)).some((role) => role === "administrator" || role === "moderator")) {
      return json({ error: "You are not authorised to create consultation rounds." }, 403);
    }
    if (!(await consumeRateLimit(db, "consultation-round-create", identity.memberId, 20, 60 * 60_000))) {
      return json({ error: "Too many consultation rounds created. Please try again later." }, 429, { "retry-after": "3600" });
    }
    const rounds = db.collection("consultation_rounds");
    if (await rounds.findOne({ roundId }, { projection: { _id: 1 } })) {
      return json({ error: "A consultation round with that roundId already exists." }, 409);
    }
    const now = new Date();
    const document = {
      roundId,
      program,
      label: program,
      status,
      opensAt,
      closesAt,
      policyIds: [...new Set(policyIds)],
      bindingBallotsEnabled: false,
      createdAt: now,
      createdBy: identity.memberId,
    };
    await rounds.insertOne(document);
    await db.collection("operational_audit").insertOne({
      actorId: identity.memberId,
      actorSource: identity.source,
      action: "consultation_round_created",
      targetType: "consultation_round",
      targetId: roundId,
      status,
      createdAt: now,
    });
    return json({ round: document }, 201);
  } catch {
    return json({ error: "The consultation round could not be created." }, 503);
  }
}
