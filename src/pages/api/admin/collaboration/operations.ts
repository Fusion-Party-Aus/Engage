import type { APIRoute } from "astro";
import { getSessionUser } from "../../../../lib/auth.ts";
import { getDatabase, runtimeEnv } from "../../../../lib/db.ts";
import {
  OperationSettingsError,
  saveCollaborationOwners,
} from "../../../../lib/collaboration-operations.ts";

export const prerender = false;

const headers = { "cache-control": "private, no-store" };

/** Administrators own the operational roster; no deployment is needed to change it. */
export const PATCH: APIRoute = async ({ request, locals }) => {
  const env = runtimeEnv(locals);
  const user = await getSessionUser(request, env);
  if (!user) return Response.json({ error: "Sign in required." }, { status: 401, headers });
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const view = await saveCollaborationOwners(await getDatabase(env), user, {
      primaryOwnerId: body.primaryOwnerId,
      backupOwnerId: body.backupOwnerId,
      retentionOwnerId: body.retentionOwnerId,
      correctionEmail: body.correctionEmail,
      escalationDetails: body.escalationDetails,
    });
    return Response.json({ saved: true, owners: view }, { headers });
  } catch (error) {
    if (error instanceof OperationSettingsError) {
      return Response.json({ error: error.message }, { status: error.status, headers });
    }
    return Response.json(
      { error: "Couldn't save the operational owners. Try again." },
      { status: 503, headers },
    );
  }
};
