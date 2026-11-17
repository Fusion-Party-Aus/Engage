import type { APIRoute } from "astro";
import { getDatabase, runtimeEnv } from "../../../lib/db.ts";
import { resolvePublicOrigin } from "../../../lib/public-origin.ts";
import { submitContribution, CollaborationError } from "../../../lib/collaboration.ts";
import { assertUploadSize, MediaError } from "../../../lib/collaboration-media.ts";
import { enforceAbuseProtection } from "../../../lib/turnstile-guard.ts";
import { tokenFromBody } from "../../../lib/turnstile.ts";
import { rateLimitSecret } from "../../../lib/rate-limit.ts";

export const prerender = false;

const headers = { "cache-control": "private, no-store" };

/**
 * Guest intake for a public collaboration matter.
 *
 * No session, account or membership is required. The response distinguishes a
 * shareable contribution from a private one so the confirmation screen can be
 * accurate, and never claims publication has happened.
 */
export const POST: APIRoute = async (context) => {
  const { request, locals, url } = context;
  const env = runtimeEnv(locals);
  try {
    if (request.headers.get("origin") !== resolvePublicOrigin({ env, requestUrl: url })) {
      throw new CollaborationError("Please send this from the Engage website.", 403);
    }
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.startsWith("multipart/form-data")) {
      throw new CollaborationError("Could not read the form. Reload it and try again.", 415);
    }
    assertUploadSize(request.headers.get("content-length"));
    const form = await request.formData();
    if (String(form.get("website") ?? "")) {
      throw new CollaborationError("Could not accept this submission.");
    }
    const db = await getDatabase(env);

    const refusal = await enforceAbuseProtection({
      request,
      env,
      db,
      action: "collaboration-submit",
      token: tokenFromBody({
        "cf-turnstile-response": String(form.get("cf-turnstile-response") ?? ""),
      }),
      adapterAddress: context.clientAddress,
    });
    if (refusal) return refusal;

    const answers: Record<string, string> = {};
    for (const [key, value] of form.entries()) {
      if (key.startsWith("answer.") && typeof value === "string") {
        answers[key.slice("answer.".length)] = value;
      }
    }
    const files = form
      .getAll("photos")
      .filter((entry): entry is File => entry instanceof File && entry.size > 0);

    const result = await submitContribution(
      db,
      {
        initiativeSlug: String(form.get("initiativeSlug") ?? ""),
        requestId: String(form.get("requestId") ?? ""),
        answers,
        caption: form.get("caption") ?? "",
        displayName: form.get("displayName") ?? "",
        email: form.get("email") ?? "",
        attribution: form.get("attribution"),
        channels: form.getAll("channels"),
        allowEdits: form.get("allowEdits") === "on",
        allowAiEdits: form.get("allowAiEdits") === "on",
        contactAllowed: form.get("contactAllowed") === "on",
        consent: form.get("consent") === "on",
        adultAttested: form.get("adultAttested") === "on",
        website: form.get("website"),
      },
      files,
      { tokenSecret: rateLimitSecret(env) },
    );
    return Response.json(
      {
        saved: true,
        shareable: result.shareable,
        reference: result.contributionId,
        manageToken: result.manageToken,
      },
      { status: 201, headers },
    );
  } catch (error) {
    if (error instanceof CollaborationError || error instanceof MediaError) {
      return Response.json({ error: error.message }, { status: error.status, headers });
    }
    return Response.json(
      { error: "Couldn't send your contribution. Try again." },
      { status: 503, headers },
    );
  }
};
