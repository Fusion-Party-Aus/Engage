import type { APIRoute } from "astro";
import { createHash, randomUUID } from "node:crypto";
import type { Db } from "mongodb";
import { getSessionUser } from "../../../../lib/auth.ts";
import { getDatabase, runtimeEnv } from "../../../../lib/db.ts";
import { saveProposal } from "../../../../lib/proposals-store.ts";
import { parseOutcomes } from "../../../../lib/proposal-helpers.ts";
import { hasPermission, hasPermissionAnywhere } from "../../../../lib/rbac.ts";
import {
  amendmentsCompete,
  validateWordingChanges,
} from "../../../../lib/amendment-suggestions.ts";

const APPLY_LEASE_MS = 60_000;

interface ProposalSnapshot {
  title: string;
  summary: string;
  outcomes: string[];
  details: string;
  targetSection?: string;
  proposedWording?: string;
}

function projectedSnapshot(
  base: Record<string, any>,
  changes: Record<string, unknown>,
): ProposalSnapshot {
  return {
    title: "title" in changes ? String(changes.title ?? "").trim() : String(base.title ?? ""),
    summary: "summary" in changes ? String(changes.summary ?? "").trim() : String(base.summary ?? ""),
    outcomes: "outcomes" in changes
      ? parseOutcomes(changes.outcomes)
      : Array.isArray(base.outcomes)
        ? base.outcomes.map(String)
        : [],
    details: "details" in changes ? String(changes.details ?? "").trim() : String(base.details ?? ""),
    ...(base.targetSection ? { targetSection: String(base.targetSection) } : {}),
    ...(base.proposedWording ? { proposedWording: String(base.proposedWording) } : {}),
  };
}

function snapshotHash(snapshot: ProposalSnapshot): string {
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

async function latestRevision(db: Db, proposalId: string) {
  const rows = await db
    .collection("proposal_revisions")
    .find({ proposalId })
    .sort({ createdAt: -1, _id: -1 })
    .limit(1)
    .toArray();
  return rows[0] as Record<string, any> | undefined;
}

async function finalise(
  db: Db,
  amendmentId: string,
  applyingToken: string,
  applyingOperationId: string,
  revisionId: string,
  user: { memberId: string },
): Promise<boolean> {
  const result = await db.collection("amendments").updateOne(
    {
      amendmentId,
      status: "applying",
      applyingToken,
      applyingOperationId,
    },
    {
      $set: {
        status: "applied",
        appliedRevisionId: revisionId,
        appliedBy: user.memberId,
        appliedAt: new Date(),
      },
      $unset: {
        applyingToken: "",
        applyingOperationId: "",
        applyingBaseRevisionId: "",
        applyingExpectedContentHash: "",
        applyingStartedAt: "",
        applyingLeaseExpiresAt: "",
        applyingBy: "",
      },
    },
  );
  return result.modifiedCount === 1;
}

async function releaseClaim(
  db: Db,
  amendmentId: string,
  applyingToken: string,
  applyingOperationId: string,
) {
  await db.collection("amendments").updateOne(
    { amendmentId, status: "applying", applyingToken, applyingOperationId },
    {
      $set: { status: "accepted" },
      $unset: {
        applyingToken: "",
        applyingOperationId: "",
        applyingBaseRevisionId: "",
        applyingExpectedContentHash: "",
        applyingStartedAt: "",
        applyingLeaseExpiresAt: "",
        applyingBy: "",
      },
    },
  );
}

export const prerender = false;
export const POST: APIRoute = async ({ request, locals }) => {
  const env = runtimeEnv(locals);
  const user = await getSessionUser(request, env);
  if (!user)
    return Response.json({ error: "Sign in required." }, { status: 401 });
  if (!user.isAdmin && !user.isBranchAdmin && !hasPermissionAnywhere(user, "amendments.apply"))
    return Response.json(
      { error: "Administrator access required." },
      { status: 403 },
    );
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const amendmentId = String(body.amendmentId ?? "");
    const db = await getDatabase(env);
    const amendment = await db
      .collection("amendments")
      .findOne({ amendmentId, status: { $in: ["accepted", "applying"] } });
    if (!amendment)
      return Response.json(
        { error: "Accepted amendment not found." },
        { status: 404 },
      );
    const recovering = amendment.status === "applying";
    if (recovering) {
      if (
        !amendment.applyingToken ||
        !amendment.applyingOperationId ||
        !amendment.applyingExpectedContentHash
      )
        return Response.json(
          {
            error:
              "This amendment is in an incomplete application state without a recovery record. Review the proposal history before continuing.",
          },
          { status: 409 },
        );
      const startedAt = amendment.applyingStartedAt
        ? new Date(amendment.applyingStartedAt).getTime()
        : 0;
      const leaseExpiresAt = amendment.applyingLeaseExpiresAt
        ? new Date(amendment.applyingLeaseExpiresAt).getTime()
        : startedAt + APPLY_LEASE_MS;
      if (leaseExpiresAt > Date.now())
        return Response.json(
          {
            error:
              "This amendment is already being applied. Wait a moment and retry if it did not finish.",
          },
          { status: 409 },
        );
    }

    const baseRevision = await db
      .collection("proposal_revisions")
      .findOne({ proposalId: amendment.proposalId, revisionId: amendment.baseRevisionId });
    if (!baseRevision)
      return Response.json(
        { error: "The amendment's base revision was not found." },
        { status: 409 },
      );
    const proposal = await db
      .collection("proposals")
      .findOne({ proposalId: amendment.proposalId });
    if (!proposal || !["propose", "deliberate"].includes(proposal.stage))
      return Response.json(
        { error: "Amendment cannot be applied after Decide begins." },
        { status: 409 },
      );
    if (
      !hasPermission(user, "amendments.apply", proposal.originatingBranchId)
    )
      return Response.json(
        {
          error: "You are not authorised to apply amendments to this proposal.",
        },
        { status: 403 },
      );

    const changes = amendment.changes as Record<string, unknown>;
    const wordingErrors = validateWordingChanges(changes);
    if (wordingErrors.length)
      return Response.json({ error: wordingErrors[0] }, { status: 400 });

    // A warning is not a safeguard. Refuse to apply an amendment that changes
    // the same block as an amendment already applied. The officer still needs
    // to record the precedence decision required by #34.
    const appliedCompetitors = await db
      .collection("amendments")
      .find({
        proposalId: amendment.proposalId,
        amendmentId: { $ne: amendmentId },
        status: "applied",
      })
      .toArray();
    if (
      appliedCompetitors.some((other) =>
        amendmentsCompete(
          amendment as unknown as Parameters<typeof amendmentsCompete>[0],
          other as unknown as Parameters<typeof amendmentsCompete>[1],
        ),
      )
    )
      return Response.json(
        {
          error:
            "Another applied amendment changes the same wording. Record an explicit precedence decision before applying this amendment.",
        },
        { status: 409 },
      );

    const expectedContentHash = recovering
      ? String(amendment.applyingExpectedContentHash)
      : snapshotHash(projectedSnapshot(baseRevision.snapshot ?? {}, changes));
    let applyingToken: string;
    let applyingOperationId: string;

    if (!recovering) {
      applyingToken = randomUUID();
      applyingOperationId = randomUUID();
      const now = new Date();
      const claim = await db.collection("amendments").updateOne(
        { amendmentId, status: "accepted", baseRevisionId: amendment.baseRevisionId },
        {
          $set: {
            status: "applying",
            applyingToken,
            applyingOperationId,
            applyingBaseRevisionId: amendment.baseRevisionId,
            applyingExpectedContentHash: expectedContentHash,
            applyingStartedAt: now,
            applyingLeaseExpiresAt: new Date(now.getTime() + APPLY_LEASE_MS),
            applyingBy: user.memberId,
          },
        },
      );
      if (claim.modifiedCount !== 1)
        return Response.json(
          {
            error:
              "The amendment changed before it could be applied. Reload the proposal and review its current state.",
          },
          { status: 409 },
        );
    } else {
      applyingOperationId = String(amendment.applyingOperationId);
      applyingToken = randomUUID();
      const now = new Date();
      const refresh = await db.collection("amendments").updateOne(
        {
          amendmentId,
          status: "applying",
          applyingToken: amendment.applyingToken,
          applyingOperationId: applyingOperationId,
          $or: [
            { applyingLeaseExpiresAt: { $lte: now } },
            {
              applyingLeaseExpiresAt: { $exists: false },
              applyingStartedAt: { $lte: new Date(now.getTime() - APPLY_LEASE_MS) },
            },
          ],
        },
        {
          $set: {
            applyingToken,
            applyingStartedAt: now,
            applyingLeaseExpiresAt: new Date(now.getTime() + APPLY_LEASE_MS),
            applyingBy: user.memberId,
          },
        },
      );
      if (refresh.modifiedCount !== 1)
        return Response.json(
          {
            error:
              "Another recovery attempt claimed this amendment. Reload the proposal and review its current state.",
          },
          { status: 409 },
        );
    }

    const current = await latestRevision(db, amendment.proposalId);
    // A crash after the write but before finalisation is completed here without
    // applying the wording a second time.
    if (current?.contentHash === expectedContentHash) {
      if (
        !(await finalise(
          db,
          amendmentId,
          applyingToken,
          applyingOperationId,
          String(current.revisionId),
          user,
        ))
      )
        return Response.json(
          {
            error:
              "The proposal already contains the amendment, but the amendment state changed before it could be finalised. Reload and review.",
          },
          { status: 409 },
        );
      return Response.json({
        proposal,
        appliedRevisionId: String(current.revisionId),
      });
    }
    if (current?.revisionId !== amendment.baseRevisionId)
      return Response.json(
        {
          error:
            "The proposal wording changed after this application started. The amendment was not applied. Review the proposal history before retrying.",
        },
        { status: 409 },
      );

    let updated: Awaited<ReturnType<typeof saveProposal>>;
    try {
      updated = await saveProposal(
        db,
        user,
        {
          proposalId: amendment.proposalId,
          ...changes,
        },
        {
          allowAmendmentApply: true,
          expectedRevisionId: amendment.baseRevisionId,
        },
      );
    } catch (error) {
      if (!recovering)
        await releaseClaim(db, amendmentId, applyingToken, applyingOperationId);
      throw error;
    }

    const after = await latestRevision(db, amendment.proposalId);
    if (after?.contentHash !== expectedContentHash)
      return Response.json(
        {
          error:
            "The proposal revision did not match the expected amendment wording. The amendment was not marked applied; review the proposal history before retrying.",
        },
        { status: 409 },
      );
    if (
      !(await finalise(
        db,
        amendmentId,
        applyingToken,
        applyingOperationId,
        String(after.revisionId),
        user,
      ))
    )
      return Response.json(
        {
          error:
            "The proposal changed but the amendment status could not be finalised. Retry apply; the operation is idempotent.",
        },
        { status: 409 },
      );
    return Response.json({
      proposal: updated,
      appliedRevisionId: String(after.revisionId),
    });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "Could not apply amendment.",
      },
      { status: 400 },
    );
  }
};
