import type { APIRoute } from "astro";
import { getSessionUser } from "../../../lib/auth.ts";
import { getDatabase, runtimeEnv } from "../../../lib/db.ts";
import {
  BranchParticipationError,
  ensureNationalBranchAssignment,
  getMemberBranchProfile,
  listBranchOptions,
  saveBranchFollowing,
  setBranchFollowing,
} from "../../../lib/branch-participation.ts";

export const prerender = false;

const headers = { "cache-control": "private, no-store" };

function errorResponse(error: unknown) {
  if (error instanceof BranchParticipationError) {
    return Response.json(
      { error: error.message, code: error.code },
      { status: error.status, headers },
    );
  }
  return Response.json(
    {
      error:
        error instanceof Error
          ? error.message
          : "Could not update your branches right now.",
    },
    { status: 400, headers },
  );
}

export const GET: APIRoute = async ({ request, locals }) => {
  const env = runtimeEnv(locals);
  const user = await getSessionUser(request, env);
  if (!user)
    return Response.json(
      { error: "Sign in to manage your branches." },
      { status: 401, headers },
    );
  const db = await getDatabase(env);
  await ensureNationalBranchAssignment(db, user.memberId);
  const [branches, profile] = await Promise.all([
    listBranchOptions(db, user.memberId),
    getMemberBranchProfile(db, user.memberId),
  ]);
  return Response.json(
    {
      branches,
      following: profile.following.map((branch) => branch.branchId),
      verified: profile.verified.map((branch) => branch.branchId),
    },
    { headers },
  );
};

/** Save a multi-branch onboarding selection or toggle one branch immediately. */
export const POST: APIRoute = async ({ request, locals }) => {
  const env = runtimeEnv(locals);
  const user = await getSessionUser(request, env);
  if (!user)
    return Response.json(
      { error: "Sign in to manage your branches." },
      { status: 401, headers },
    );
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const db = await getDatabase(env);
    let profile;
    if (Array.isArray(body.branchIds)) {
      profile = await saveBranchFollowing(db, user.memberId, body.branchIds);
    } else if (typeof body.branchId === "string" && body.branchId.trim()) {
      profile = await setBranchFollowing(
        db,
        user.memberId,
        body.branchId.trim(),
        body.following !== false,
      );
    } else {
      return Response.json(
        { error: "Choose at least one branch, or skip for now." },
        { status: 400, headers },
      );
    }
    return Response.json(
      {
        branches: await listBranchOptions(db, user.memberId),
        following: profile.following.map((branch) => branch.branchId),
        verified: profile.verified.map((branch) => branch.branchId),
        message: "Your branch choices are saved.",
      },
      { headers },
    );
  } catch (error) {
    return errorResponse(error);
  }
};
