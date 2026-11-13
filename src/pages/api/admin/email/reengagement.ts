import type { APIRoute } from "astro";
import { getSessionUser } from "../../../../lib/auth.ts";
import { getDatabase, runtimeEnv } from "../../../../lib/db.ts";
import {
  ReengagementError,
  approveReengagementCampaign,
  previewMemberReengagement,
  runApprovedReengagementBatch,
} from "../../../../lib/member-reengagement.ts";
import { requireApiPermission } from "../../../../lib/rbac.ts";

export const prerender = false;

export const GET: APIRoute = async ({ request, locals, url }) => {
  const env = runtimeEnv(locals);
  const user = await getSessionUser(request, env);
  const denied = requireApiPermission(user, "engagement.manage", {
    message: "Administrator access required",
  });
  if (denied) return denied;
  try {
    const report = await previewMemberReengagement(
      await getDatabase(env),
      new Date(url.searchParams.get("cutoff") || ""),
      new Date(),
      url.searchParams.get("include") === "members",
    );
    return Response.json(report, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return Response.json(
      { error: "Supply a valid historical cutoff date." },
      { status: 400 },
    );
  }
};

export const POST: APIRoute = async ({ request, locals }) => {
  const env = runtimeEnv(locals);
  const user = await getSessionUser(request, env);
  const denied = requireApiPermission(user, "engagement.manage", {
    message: "Administrator access required",
  });
  if (denied || !user) {
    return denied ?? Response.json({ error: "Sign in required" }, { status: 401 });
  }

  try {
    const body = (await request.json()) as Record<string, unknown>;
    const db = await getDatabase(env);
    const action = String(body.action ?? "");
    const campaignId = String(body.campaignId ?? "");

    if (action === "approve") {
      const campaign = await approveReengagementCampaign(db, user, {
        campaignId,
        cutoff: new Date(String(body.cutoff ?? "")),
        note: String(body.note ?? ""),
      });
      return Response.json({ campaign }, { status: 201 });
    }

    if (action === "send-batch") {
      const result = await runApprovedReengagementBatch(db, env, user, {
        campaignId,
        batchSize: typeof body.batchSize === "number" ? body.batchSize : 25,
      });
      return Response.json(result, { status: 200 });
    }

    return Response.json({ error: "Unsupported re-engagement action." }, { status: 400 });
  } catch (error) {
    if (error instanceof ReengagementError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    return Response.json(
      { error: error instanceof Error ? error.message : "Re-engagement failed." },
      { status: 400 },
    );
  }
};
