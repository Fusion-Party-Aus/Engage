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
  const db = await getDatabase(env);
  const events = await db
    .collection("publication_events")
    .find({ status: "pending" })
    .sort({ publishedAt: 1 })
    .limit(100)
    .toArray();
  let completed = 0;
  for (const event of events) {
    const transition = event.transition ?? "published";
    const update =
      transition === "withdrawn"
        ? {
            $set: {
              publicationStatus: "withdrawn",
              withdrawnAt: event.createdAt,
              withdrawalReason: event.reason,
            },
          }
        : transition === "superseded"
          ? {
              $set: {
                publicationStatus: "superseded",
                supersededAt: event.createdAt,
                supersededBy: event.successorPolicyId,
              },
            }
          : {
              $set: {
                publicationStatus: "published",
                publishedAt: event.publishedAt,
              },
            };
    const filter: Record<string, unknown> = {
      policyId: event.policyId,
      revisionId: event.revisionId,
      status: "adopted",
    };
    if (transition !== "published") filter.publicationStatus = "published";
    const updated = await db
      .collection("policy_registry")
      .updateOne(filter, update);
    if (updated.matchedCount) {
      await db
        .collection("publication_events")
        .updateOne(
          { eventId: event.eventId, status: "pending" },
          {
            $set: {
              status: transition,
              completedAt: new Date(),
              reconciledBy: user.memberId,
            },
          },
        );
      completed++;
    }
  }
  return Response.json({ inspected: events.length, completed });
};
