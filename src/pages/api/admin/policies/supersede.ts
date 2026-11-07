import type { APIRoute } from "astro";
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
    const policyId = String(body.policyId ?? "");
    const successorPolicyId = String(body.successorPolicyId ?? "");
    const reason =
      typeof body.reason === "string" ? body.reason.trim().slice(0, 1000) : "";
    const key = request.headers.get("idempotency-key");
    if (
      !policyId ||
      !successorPolicyId ||
      policyId === successorPolicyId ||
      !reason ||
      !key ||
      key.length > 200
    )
      return Response.json(
        {
          error:
            "Distinct policy IDs, reason and Idempotency-Key are required.",
        },
        { status: 400 },
      );
    const db = await getDatabase(env);
    const col = db.collection("policy_registry");
    const eventId = `supersede-${key}`;
    const priorEvent = await db
      .collection("publication_events")
      .findOne({ eventId });
    if (
      priorEvent &&
      (priorEvent.policyId !== policyId ||
        priorEvent.transition !== "superseded" ||
        priorEvent.successorPolicyId !== successorPolicyId)
    )
      return Response.json(
        {
          error: "Idempotency key was used for a different publication event.",
        },
        { status: 409 },
      );
    if (priorEvent?.status === "superseded")
      return Response.json({ event: priorEvent }, { status: 200 });
    const [oldPolicy, successor] = await Promise.all([
      col.findOne({
        policyId,
        publicationStatus: { $in: ["published", "superseded"] },
      }),
      col.findOne({ policyId: successorPolicyId, status: "adopted" }),
    ]);
    if (!oldPolicy || !successor)
      return Response.json(
        {
          error:
            "Published source and adopted successor policies are required.",
        },
        { status: 409 },
      );
    if (oldPolicy.publicationStatus !== "published" && !priorEvent)
      return Response.json(
        { error: "Policy publication has already changed." },
        { status: 409 },
      );
    const event = {
      eventId: `supersede-${key}`,
      idempotencyKey: key,
      policyId,
      revisionId: oldPolicy.revisionId,
      successorPolicyId,
      successorRevisionId: successor.revisionId,
      jurisdiction: oldPolicy.jurisdiction,
      jurisdictionBranchId: oldPolicy.jurisdictionBranchId,
      status: "pending",
      transition: "superseded",
      provenance: oldPolicy.provenance,
      reason,
      actorId: user.memberId,
      createdAt: new Date(),
    };
    await db
      .collection("publication_events")
      .updateOne(
        { eventId: event.eventId },
        { $setOnInsert: event },
        { upsert: true },
      );
    const saved = await db
      .collection("publication_events")
      .findOne({ eventId: event.eventId });
    if (
      saved?.policyId !== policyId ||
      saved?.revisionId !== oldPolicy.revisionId ||
      saved?.successorRevisionId !== successor.revisionId
    )
      return Response.json(
        {
          error: "Idempotency key was used for a different publication event.",
        },
        { status: 409 },
      );
    await col.updateOne(
      {
        policyId,
        revisionId: oldPolicy.revisionId,
        publicationStatus: "published",
      },
      {
        $set: {
          publicationStatus: "superseded",
          supersededBy: successorPolicyId,
          supersededAt: saved.createdAt,
        },
      },
    );
    await db
      .collection("publication_events")
      .updateOne(
        { eventId: event.eventId },
        { $set: { status: "superseded", completedAt: new Date() } },
      );
    return Response.json(
      {
        event: await db
          .collection("publication_events")
          .findOne({ eventId: event.eventId }),
      },
      { status: 201 },
    );
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Could not supersede policy.",
      },
      { status: 400 },
    );
  }
};
