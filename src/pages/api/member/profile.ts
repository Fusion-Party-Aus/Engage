import type { APIRoute } from "astro";
import { getSessionUser } from "../../../lib/auth.ts";
import { privateJson } from "../../../lib/api-contracts.ts";
import { getDatabase, runtimeEnv } from "../../../lib/db.ts";
import {
  getMemberBioSettings,
  saveMemberBio,
} from "../../../lib/member-profile.ts";
import { resolvePublicOrigin } from "../../../lib/public-origin.ts";

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  const env = runtimeEnv(locals);
  const user = await getSessionUser(request, env);
  if (!user) return privateJson({ error: "Sign in required." }, { status: 401 });

  const db = await getDatabase(env);
  return privateJson({ bio: await getMemberBioSettings(db, user.memberId) });
};

export const POST: APIRoute = async ({ request, locals, url }) => {
  const env = runtimeEnv(locals);
  if (
    request.headers.get("origin") !==
    resolvePublicOrigin({ env, requestUrl: url })
  ) {
    return privateJson({ error: "Invalid origin" }, { status: 403 });
  }

  const user = await getSessionUser(request, env);
  if (!user) return privateJson({ error: "Sign in required." }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return privateJson({ error: "Invalid JSON payload" }, { status: 400 });
  }

  try {
    const db = await getDatabase(env);
    const bio = await saveMemberBio(db, user, body.bio);
    return privateJson({ ok: true, bio });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message === "Account record not found.") {
      return privateJson({ error: message }, { status: 404 });
    }
    if (message.startsWith("Biography")) {
      return privateJson({ error: message }, { status: 400 });
    }
    return privateJson(
      { error: "Could not save biography. Try again." },
      { status: 400 },
    );
  }
};
