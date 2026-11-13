import type { APIRoute } from "astro";
import { getSessionUser } from "../../../../lib/auth.ts";
import { privateJson, toPublicationEventDto } from "../../../../lib/api-contracts.ts";
import { getDatabase, runtimeEnv } from "../../../../lib/db.ts";
import { requireApiPermission } from "../../../../lib/rbac.ts";
import { isPolicyRegistryRecordForResolution } from "../../../../lib/store.ts";

export const prerender = false;
export const POST: APIRoute = async ({ request, locals }) => {
  const env = runtimeEnv(locals);
  const user = await getSessionUser(request, env);
  const denied = requireApiPermission(user, "policies.publish", {
    message: "Administrator access required.",
  });
  if (denied || !user) return denied ?? Response.json({ error: "Sign in required." }, { status: 401 });
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const policyId = String(body.policyId ?? "");
    if (!policyId)
      return Response.json({ error: "policyId is required." }, { status: 400 });
    const db = await getDatabase(env);
    const col = db.collection("policy_registry");
    const policy = await col.findOne({ policyId });
    if (!policy)
      return Response.json(
        { error: "Ratified policy not found." },
        { status: 404 },
      );
    const linkedProposal = await db
      .collection("proposals")
      .findOne({ proposalId: String(policy.proposalId ?? policyId) });
    if (
      isPolicyRegistryRecordForResolution(
        policy as { policyId?: string; proposalId?: string; kind?: string },
        linkedProposal as { kind?: string; proposalId?: string } | null,
      )
    )
      return Response.json(
        {
          error:
            "Governance resolutions cannot be published in the Policy Registry.",
        },
        { status: 409 },
      );
    if (
      policy.status !== "adopted" ||
      !policy.revisionId ||
      !policy.ratification?.decisionEventId
    )
      return Response.json(
        { error: "Only explicitly ratified policies can be published." },
        { status: 409 },
      );
    const key = request.headers.get("idempotency-key");
    if (!key || key.length > 200)
      return Response.json(
        { error: "A valid Idempotency-Key header is required." },
        { status: 400 },
      );
    const event = {
      eventId: `pub-${key}`,
      idempotencyKey: key,
      policyId,
      revisionId: policy.revisionId,
      jurisdiction: policy.jurisdiction,
      jurisdictionBranchId: policy.jurisdictionBranchId,
      status: "pending",
      provenance: policy.provenance,
      publishedBy: user.memberId,
      publishedAt: new Date(),
    };
    const priorEvent = await db
      .collection("publication_events")
      .findOne({ eventId: event.eventId });
    if (
      priorEvent &&
      (priorEvent.policyId !== policyId ||
        priorEvent.revisionId !== policy.revisionId ||
        (priorEvent.transition && priorEvent.transition !== "published"))
    )
      return Response.json(
        {
          error: "Idempotency key was used for another publication transition.",
        },
        { status: 409 },
      );
    if (policy.publicationStatus !== "unpublished" && !priorEvent)
      return Response.json(
        {
          error:
            "This policy is already published or its publication state has changed.",
        },
        { status: 409 },
      );
    await db
      .collection("publication_events")
      .updateOne(
        { eventId: event.eventId },
        { $setOnInsert: event },
        { upsert: true },
      );
    const durableEvent = await db
      .collection("publication_events")
      .findOne({ eventId: event.eventId });
    if (
      durableEvent?.policyId !== policyId ||
      durableEvent?.revisionId !== policy.revisionId
    )
      return Response.json(
        { error: "Idempotency key was used for another publication." },
        { status: 409 },
      );
    await col.updateOne(
      { policyId, revisionId: policy.revisionId },
      {
        $set: {
          publicationStatus: "published",
          publishedAt: durableEvent?.publishedAt,
        },
      },
    );
    await db
      .collection("publication_events")
      .updateOne(
        { eventId: event.eventId, status: "pending" },
        { $set: { status: "published", completedAt: new Date() } },
      );
    const savedEvent = await db
      .collection("publication_events")
      .findOne({ eventId: event.eventId });
    return privateJson(
      {
        event: savedEvent ? toPublicationEventDto(savedEvent) : null,
      },
      { status: 201 },
    );
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Publication failed." },
      { status: 400 },
    );
  }
};
