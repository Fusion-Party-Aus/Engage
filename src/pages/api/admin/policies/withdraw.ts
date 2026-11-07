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
    const reason =
      typeof body.reason === "string" ? body.reason.trim().slice(0, 1000) : "";
    const key = request.headers.get("idempotency-key");
    if (!policyId || !reason || !key || key.length > 200)
      return Response.json(
        { error: "policyId, reason and Idempotency-Key are required." },
        { status: 400 },
      );
    const db = await getDatabase(env);
    const col = db.collection("policy_registry");
    const eventId = `withdraw-${key}`;
    const priorEvent = await db
      .collection("publication_events")
      .findOne({ eventId });
    if (
      priorEvent &&
      (priorEvent.policyId !== policyId ||
        priorEvent.transition !== "withdrawn")
    )
      return Response.json(
        {
          error: "Idempotency key was used for a different publication event.",
        },
        { status: 409 },
      );
    if (priorEvent?.status === "withdrawn")
      return Response.json({ event: priorEvent }, { status: 200 });
    const policy = await col.findOne({
      policyId,
      publicationStatus: { $in: ["published", "withdrawn"] },
    });
    if (!policy)
      return Response.json(
        { error: "Published policy not found." },
        { status: 404 },
      );
    if (policy.publicationStatus !== "published" && !priorEvent)
      return Response.json(
        { error: "Policy publication has already changed." },
        { status: 409 },
      );
    const event = {
      eventId: `withdraw-${key}`,
      idempotencyKey: key,
      policyId,
      revisionId: policy.revisionId,
      jurisdiction: policy.jurisdiction,
      jurisdictionBranchId: policy.jurisdictionBranchId,
      status: "pending",
      transition: "withdrawn",
      provenance: policy.provenance,
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
    if (saved?.policyId !== policyId || saved?.revisionId !== policy.revisionId)
      return Response.json(
        {
          error: "Idempotency key was used for a different publication event.",
        },
        { status: 409 },
      );
    await col.updateOne(
      {
        policyId,
        revisionId: policy.revisionId,
        publicationStatus: "published",
      },
      {
        $set: {
          publicationStatus: "withdrawn",
          withdrawnAt: saved.createdAt,
          withdrawalReason: reason,
        },
      },
    );
    await db
      .collection("publication_events")
      .updateOne(
        { eventId: event.eventId },
        { $set: { status: "withdrawn", completedAt: new Date() } },
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
          error instanceof Error ? error.message : "Could not withdraw policy.",
      },
      { status: 400 },
    );
  }
};
