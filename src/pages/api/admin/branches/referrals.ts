import type { APIRoute } from "astro";
import { randomUUID } from "node:crypto";
import { getSessionUser } from "../../../../lib/auth.ts";
import { getDatabase, runtimeEnv } from "../../../../lib/db.ts";

export const prerender = false;
export const POST: APIRoute = async ({ request, locals }) => {
  const env = runtimeEnv(locals);
  const user = await getSessionUser(request, env);
  if (!user)
    return Response.json({ error: "Sign in required." }, { status: 401 });
  if (!user.isAdmin)
    return Response.json(
      { error: "Administrator access required." },
      { status: 403 },
    );
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const proposalId = String(body.proposalId ?? "");
    const targetBranchId = String(body.targetBranchId ?? "");
    const sourceBranchId =
      typeof body.sourceBranchId === "string" ? body.sourceBranchId : undefined;
    const reason =
      typeof body.reason === "string" ? body.reason.trim().slice(0, 1000) : "";
    if (!proposalId || !targetBranchId || !reason)
      return Response.json(
        {
          error: "proposalId, targetBranchId and referral reason are required.",
        },
        { status: 400 },
      );
    const db = await getDatabase(env);
    const proposal = await db.collection("proposals").findOne({ proposalId });
    const target = await db
      .collection("branches")
      .findOne({ branchId: targetBranchId, recognised: true });
    const source = sourceBranchId
      ? await db
          .collection("branches")
          .findOne({ branchId: sourceBranchId, recognised: true })
      : null;
    if (!proposal)
      return Response.json({ error: "Proposal not found." }, { status: 404 });
    if (!target)
      return Response.json(
        { error: "Target must be a recognised branch." },
        { status: 400 },
      );
    if (sourceBranchId && !source)
      return Response.json(
        { error: "Source must be a recognised branch." },
        { status: 400 },
      );
    const referral = {
      referralId: randomUUID(),
      proposalId,
      sourceBranchId: sourceBranchId ?? proposal.originatingBranchId ?? null,
      targetBranchId,
      reason,
      status: "referred",
      referredBy: user.memberId,
      referredAt: new Date(),
    };
    await db.collection("branch_referrals").insertOne(referral);
    return Response.json({ referral }, { status: 201 });
  } catch (error) {
    if ((error as { code?: number }).code === 11000)
      return Response.json(
        { error: "This proposal has already been referred to that branch." },
        { status: 409 },
      );
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "Could not refer proposal.",
      },
      { status: 400 },
    );
  }
};

export const GET: APIRoute = async ({ request, url, locals }) => {
  const env = runtimeEnv(locals);
  const user = await getSessionUser(request, env);
  if (!user)
    return Response.json({ error: "Sign in required." }, { status: 401 });
  if (!user.isAdmin)
    return Response.json(
      { error: "Administrator access required." },
      { status: 403 },
    );
  const targetBranchId = url.searchParams.get("branch") ?? "";
  if (!targetBranchId)
    return Response.json(
      { error: "branch filter is required." },
      { status: 400 },
    );
  const rows = await (
    await getDatabase(env)
  )
    .collection("branch_referrals")
    .find({ targetBranchId })
    .sort({ referredAt: -1 })
    .toArray();
  return Response.json(
    { referrals: rows.map(({ _id, ...row }) => row) },
    { headers: { "cache-control": "private, no-store" } },
  );
};
