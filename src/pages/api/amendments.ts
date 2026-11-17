import type { APIRoute } from "astro";
import { randomUUID } from "node:crypto";
import { getSessionUser } from "../../lib/auth.ts";
import {
  parsePagination,
  privateJson,
  toAmendmentDto,
} from "../../lib/api-contracts.ts";
import { getDatabase, runtimeEnv } from "../../lib/db.ts";
import { requireLegalAcceptance } from "../../lib/legal-acceptance.ts";
import { createAmendmentRevision } from "../../lib/amendments.ts";
import {
  applySuggestions,
  classifySuggestions,
  normalizeSuggestions,
  validateWordingChanges,
  wordingSnapshot,
  type AmendmentSuggestion,
} from "../../lib/amendment-suggestions.ts";
import {
  canReviewArchivedProposal,
  canViewProposal,
  normalizeProposalDoc,
} from "../../lib/store.ts";
export const prerender = false;
export const GET: APIRoute = async ({ url, locals, request }) => {
  const env = runtimeEnv(locals);
  const user = await getSessionUser(request, env);
  if (!user)
    return privateJson({ error: "Sign in required." }, { status: 401 });
  const proposalId = url.searchParams.get("proposalId") ?? "";
  if (!proposalId)
    return privateJson({ error: "proposalId is required." }, { status: 400 });
  const { limit, offset } = parsePagination(url, { defaultLimit: 50, maxLimit: 200 });
  const db = await getDatabase(env);
  const proposal = await db.collection("proposals").findOne({ proposalId });
  const normalizedProposal = proposal ? normalizeProposalDoc(proposal) : null;
  if (
    !normalizedProposal ||
    !canViewProposal(normalizedProposal, user) ||
    (normalizedProposal.stage === "archived" &&
      !canReviewArchivedProposal(normalizedProposal, user))
  )
    return privateJson({ error: "Proposal not found." }, { status: 404 });
  const query: Record<string, unknown> = { proposalId };
  if (!user.isStaff) query.status = { $ne: "withdrawn" };
  const rows = await db
    .collection("amendments")
    .find(query)
    .sort({ createdAt: 1 })
    .limit(offset + limit + 1)
    .toArray();
  const sliced = rows.slice(offset);
  const hasMore = sliced.length > limit;
  const page = sliced.slice(0, limit).map(toAmendmentDto);
  return privateJson({
    amendments: page,
    meta: { limit, offset, hasMore },
  });
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
    if (!proposalId || !baseRevisionId)
      return Response.json(
        { error: "Provide the proposal and the exact wording revision you are amending." },
        { status: 400 },
      );
    const changesInput =
      body.changes &&
      typeof body.changes === "object" &&
      !Array.isArray(body.changes)
        ? (body.changes as Record<string, unknown>)
        : {};
    const hasSuggestions = body.suggestions !== undefined;
    if (hasSuggestions && body.changes !== undefined)
      return Response.json(
        { error: "Submit either block suggestions or replacement wording, not both." },
        { status: 400 },
      );
    const supportedFields = ["title", "summary", "details", "outcomes"];
    if (!hasSuggestions) {
      const fields = Object.keys(changesInput);
      if (!fields.length || fields.some((f) => !supportedFields.includes(f)))
        return Response.json(
          { error: "Provide the wording changes you want to make." },
          { status: 400 },
        );
      for (const [field, value] of Object.entries(changesInput)) {
        const valid =
          field === "outcomes"
            ? Array.isArray(value) && value.every((item) => typeof item === "string")
            : typeof value === "string";
        if (!valid)
          return Response.json(
            { error: `The proposed ${field} is not valid.` },
            { status: 400 },
          );
      }
    }
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

    let changes: Record<string, unknown>;
    let suggestions: AmendmentSuggestion[] | undefined;
    if (hasSuggestions) {
      try {
        suggestions = normalizeSuggestions(body.suggestions);
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : "Check the suggested changes." },
          { status: 400 },
        );
      }
      const applied = applySuggestions(wordingSnapshot(base.snapshot), suggestions, { strict: true });
      if (applied.unresolved.length)
        return Response.json(
          {
            error:
              "Some suggested changes no longer match the wording you are editing. Reload the proposal and try again.",
          },
          { status: 409 },
        );
      changes = applied.changes as Record<string, unknown>;
    } else {
      changes = changesInput;
    }
    const fields = Object.keys(changes);
    if (!fields.length)
      return Response.json(
        { error: "The suggested changes do not alter the wording." },
        { status: 400 },
      );
    const wordingErrors = validateWordingChanges(changes);
    if (wordingErrors.length)
      return Response.json({ error: wordingErrors[0] }, { status: 400 });

    const latestRows = await db
      .collection("proposal_revisions")
      .find({ proposalId })
      .sort({ createdAt: -1 })
      .limit(1)
      .toArray();
    const latest = latestRows[0];
    const stale = latest?.revisionId !== baseRevisionId;
    let conflicts: string[] = [];
    if (stale && latest) {
      if (suggestions) {
        const classifications = classifySuggestions(
          wordingSnapshot(base.snapshot),
          wordingSnapshot(latest.snapshot),
          suggestions,
        );
        const conflicted = new Set<string>();
        for (const classification of classifications) {
          if (classification.state !== "conflict") continue;
          const field = suggestions.find(
            (suggestion) => suggestion.suggestionId === classification.suggestionId,
          )?.field;
          if (field) conflicted.add(field);
        }
        conflicts = [...conflicted];
      } else {
        conflicts = fields.filter(
          (field) =>
            JSON.stringify(base.snapshot[field]) !==
            JSON.stringify(latest.snapshot[field]),
        );
      }
    }
    const amendmentId = randomUUID();
    const currentRevisionId = await createAmendmentRevision(
      db,
      amendmentId,
      changes,
      user.memberId,
      null,
      suggestions,
    );
    const record = {
      amendmentId,
      proposalId,
      baseRevisionId,
      authorId: user.memberId,
      currentRevisionId,
      changes,
      fields,
      ...(suggestions ? { suggestions } : {}),
      status: conflicts.length ? "conflict" : stale ? "stale" : "proposed",
      conflicts,
      createdAt: new Date(),
    };
    await db.collection("amendments").insertOne(record);
    return privateJson({ amendment: toAmendmentDto(record) }, { status: 201 });
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
