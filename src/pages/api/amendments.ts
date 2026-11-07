import type { APIRoute } from "astro";
import { randomUUID } from "node:crypto";
import { getSessionUser } from "../../lib/auth.ts";
import { getDatabase, runtimeEnv } from "../../lib/db.ts";
import { requireLegalAcceptance } from "../../lib/legal-acceptance.ts";
import { createAmendmentRevision } from "../../lib/amendments.ts";
import {
  canViewProposal,
  normalizeProposalDoc,
} from "../../lib/store.ts";
export const prerender = false;
export const GET: APIRoute = async ({ url, locals, request }) => {
  const env = runtimeEnv(locals);
  const user = await getSessionUser(request, env);
  if (!user)
    return Response.json({ error: "Sign in required." }, { status: 401 });
  const proposalId = url.searchParams.get("proposalId") ?? "";
  if (!proposalId)
    return Response.json({ error: "proposalId is required." }, { status: 400 });
  const db = await getDatabase(env);
  const proposal = await db.collection("proposals").findOne({ proposalId });
  if (
    !proposal ||
    !canViewProposal(normalizeProposalDoc(proposal), user)
  )
    return Response.json({ error: "Proposal not found." }, { status: 404 });
  const query: Record<string, unknown> = { proposalId };
  if (!user.isStaff) query.status = { $ne: "withdrawn" };
  const amendments = await db
    .collection("amendments")
    .find(query)
    .sort({ createdAt: 1 })
    .toArray();
  return Response.json(
    { amendments: amendments.map(({ _id, ...row }) => row) },
    { headers: { "cache-control": "private, no-store" } },
  );
};
export const POST: APIRoute = async ({ request, locals }) => {
  const env = runtimeEnv(locals);
  const user = await getSessionUser(request, env);
  if (!user)
    return Response.json({ error: "Sign in required." }, { status: 401 });
  if (!user.canParticipate && !user.isStaff)
    return Response.json(
      { error: "Verified membership required." },
      { status: 403 },
    );
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const proposalId = String(body.proposalId ?? "");
    const baseRevisionId = String(body.baseRevisionId ?? "");
    const changes =
      body.changes &&
      typeof body.changes === "object" &&
      !Array.isArray(body.changes)
        ? (body.changes as Record<string, unknown>)
        : {};
    const fields = Object.keys(changes);
    if (
      !proposalId ||
      !baseRevisionId ||
      !fields.length ||
      fields.some(
        (f) => !["title", "summary", "details", "outcomes"].includes(f),
      )
    )
      return Response.json(
        {
          error:
            "Provide proposalId, baseRevisionId and changes to supported content fields.",
        },
        { status: 400 },
      );
    const db = await getDatabase(env);
    const gate = await requireLegalAcceptance(db, user, env);
    if (gate) return gate;
    const proposal = await db.collection("proposals").findOne({ proposalId });
    if (
      !proposal ||
      !canViewProposal(normalizeProposalDoc(proposal), user)
    )
      return Response.json(
        { error: "Proposal revision not found." },
        { status: 404 },
      );
    const base = await db
      .collection("proposal_revisions")
      .findOne({ proposalId, revisionId: baseRevisionId });
    if (!base)
      return Response.json(
        { error: "Proposal revision not found." },
        { status: 404 },
      );
    if (!["propose", "deliberate"].includes(proposal.stage))
      return Response.json(
        { error: "Amendments can only be proposed before the Decide stage." },
        { status: 409 },
      );
    const latestRows = await db
      .collection("proposal_revisions")
      .find({ proposalId })
      .sort({ createdAt: -1 })
      .limit(1)
      .toArray();
    const latest = latestRows[0];
    const stale = latest?.revisionId !== baseRevisionId;
    const conflicts = stale
      ? fields.filter(
          (field) =>
            JSON.stringify(base.snapshot[field]) !==
            JSON.stringify(latest.snapshot[field]),
        )
      : [];
    const amendmentId = randomUUID();
    const currentRevisionId = await createAmendmentRevision(
      db,
      amendmentId,
      changes,
      user.memberId,
    );
    const record = {
      amendmentId,
      proposalId,
      baseRevisionId,
      authorId: user.memberId,
      currentRevisionId,
      changes,
      fields,
      status: conflicts.length ? "conflict" : stale ? "stale" : "proposed",
      conflicts,
      createdAt: new Date(),
    };
    await db.collection("amendments").insertOne(record);
    return Response.json({ amendment: record }, { status: 201 });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Could not submit amendment.",
      },
      { status: 400 },
    );
  }
};
