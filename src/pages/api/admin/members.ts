import type { APIRoute } from "astro";
import { getSessionUser } from "../../../lib/auth.ts";
import { getDatabase, runtimeEnv } from "../../../lib/db.ts";
import { listMembers, saveMember } from "../../../lib/store.ts";
import type { PlatformEnv } from "../../../lib/types.ts";

export const prerender = false;

async function sendVerificationNotice(
  env: PlatformEnv,
  email: unknown,
  name: unknown,
): Promise<"sent" | "failed"> {
  if (
    typeof email !== "string" ||
    !env.RESEND_API_KEY ||
    !env.AUTH_EMAIL_FROM ||
    !env.BETTER_AUTH_URL
  )
    return "failed";
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: env.AUTH_EMAIL_FROM,
        to: [email],
        subject: "Your Engage membership is verified",
        text: `Hello ${typeof name === "string" && name ? name : "member"},\n\nYour membership has been verified. You can now participate in open decisions on Engage.\n\n${env.BETTER_AUTH_URL}/member/`,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    return response.ok ? "sent" : "failed";
  } catch (error) {
    console.error("Membership verification email failed to send.", error);
    return "failed";
  }
}

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

  const db = await getDatabase(env);
  const accounts = await listMembers(db, url.searchParams.get("q") ?? "");
  return Response.json(
    { accounts, currentMemberId: user.memberId },
    { headers: { "cache-control": "private, no-store" } },
  );
};

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
    const db = await getDatabase(env);
    const result = await saveMember(db, user, body, true);
    const notification =
      body.status === "verified" && body.disabled !== true
        ? await sendVerificationNotice(
            env,
            typeof body.email === "string"
              ? body.email.trim().toLowerCase()
              : body.email,
            body.name,
          )
        : "not-needed";
    return Response.json({ ...result, notification }, { status: 201 });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "Could not create account.",
      },
      { status: 400 },
    );
  }
};

export const PATCH: APIRoute = async ({ request, locals }) => {
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
    const db = await getDatabase(env);
    const memberId = typeof body.memberId === "string" ? body.memberId : "";
    const wasVerified = memberId
      ? await db
          .collection("memberships")
          .findOne({ memberId, status: "verified" })
      : null;
    const account = memberId
      ? await db
          .collection("user")
          .findOne({ _id: new (await import("mongodb")).ObjectId(memberId) })
      : null;
    const result = await saveMember(db, user, body, false);
    const willBeVerified =
      body.status === undefined
        ? Boolean(wasVerified)
        : body.status === "verified";
    const willBeEnabled =
      body.disabled === undefined
        ? account?.disabled !== true
        : body.disabled === false;
    const activated =
      willBeVerified &&
      willBeEnabled &&
      (!wasVerified || account?.disabled === true);
    const notification = activated
      ? await sendVerificationNotice(env, account?.email, account?.name)
      : "not-needed";
    return Response.json({ ...result, notification });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "Could not update account.",
      },
      { status: 400 },
    );
  }
};
