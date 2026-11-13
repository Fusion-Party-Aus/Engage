import type { APIRoute } from "astro";
import { ObjectId } from "mongodb";
import { getSessionUser } from "../../../lib/auth.ts";
import {
  parsePagination,
  privateJson,
  toMemberAccountDto,
} from "../../../lib/api-contracts.ts";
import { getDatabase, runtimeEnv } from "../../../lib/db.ts";
import { hasPermission, requireApiPermission } from "../../../lib/rbac.ts";
import { listMembers, saveMember } from "../../../lib/store.ts";
import { sendVerificationNotice } from "../../../lib/verification-email.ts";
export const prerender = false;

export const GET: APIRoute = async ({ request, url, locals }) => {
  const env = runtimeEnv(locals);
  const user = await getSessionUser(request, env);
  const denied = requireApiPermission(user, "members.view", {
    message: "Administrator access required.",
  });
  if (denied) return denied;

  const { limit, offset } = parsePagination(url, { defaultLimit: 100, maxLimit: 250 });
  const db = await getDatabase(env);
  const allAccounts = await listMembers(db, url.searchParams.get("q") ?? "");
  const page = allAccounts.slice(offset, offset + limit).map(toMemberAccountDto);
  return privateJson({
    accounts: page,
    currentMemberId: user!.memberId,
    meta: {
      limit,
      offset,
      total: allAccounts.length,
      hasMore: offset + page.length < allAccounts.length,
    },
  });
};

export const POST: APIRoute = async ({ request, locals }) => {
  const env = runtimeEnv(locals);
  const user = await getSessionUser(request, env);
  const denied = requireApiPermission(user, "members.verify", {
    message: "Administrator access required.",
  });
  if (denied) return denied;

  try {
    const body = (await request.json()) as Record<string, unknown>;
    const db = await getDatabase(env);
    const result = await saveMember(db, user!, body, true);
    const notification = body.status === "verified" && body.disabled !== true
      ? await sendVerificationNotice(db, env, result.memberId, "verified") : "not-needed";
    return privateJson({ ...result, notification }, { status: 201 });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "Could not create account.",
      },
      { status: 400 },
    );
  }
};

export const PATCH: APIRoute = async ({ request, locals }) => {
  const env = runtimeEnv(locals);
  const user = await getSessionUser(request, env);
  if (!user) {
    return privateJson({ error: "Sign in required." }, { status: 401 });
  }

  try {
    const body = (await request.json()) as Record<string, unknown>;
    const changingMembership =
      body.status !== undefined ||
      body.disabled !== undefined ||
      body.name !== undefined;
    const changingRole = body.role !== undefined;
    if (!changingMembership && !changingRole) {
      return privateJson(
        { error: "Choose a membership or role change." },
        { status: 400 },
      );
    }
    if (changingRole && !hasPermission(user, "roles.manage")) {
      return privateJson(
        { error: "Role management permission required to change member roles." },
        { status: 403 },
      );
    }
    if (changingMembership && !hasPermission(user, "members.verify")) {
      return privateJson(
        { error: "Member verification permission required." },
        { status: 403 },
      );
    }
    const db = await getDatabase(env);
    const memberId = typeof body.memberId === "string" ? body.memberId : "";
    if (!ObjectId.isValid(memberId)) {
      return privateJson(
        { error: "Choose a valid member account." },
        { status: 400 },
      );
    }
    const wasVerified = await db
      .collection("memberships")
      .findOne({ memberId, status: "verified" });
    const account = await db
      .collection("user")
      .findOne({ _id: new ObjectId(memberId) });
    const result = await saveMember(db, user, body, false);
    const willBeVerified =
      body.status === undefined
        ? Boolean(wasVerified)
        : body.status === "verified";
    const willBeEnabled =
      body.disabled === undefined
        ? account?.disabled !== true
        : body.disabled === false;
    const activated =
      willBeVerified &&
      willBeEnabled &&
      (!wasVerified || account?.disabled === true);
    const notification = activated
      ? await sendVerificationNotice(db, env, memberId, "verified")
      : body.status === "suspended" && wasVerified
        ? await sendVerificationNotice(db, env, memberId, "suspended") : "not-needed";
    return privateJson({ ...result, notification });
  } catch (error) {
    return privateJson(
      {
        error:
          error instanceof Error ? error.message : "Could not update account.",
      },
      { status: 400 },
    );
  }
};
