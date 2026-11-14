import type { APIRoute } from "astro";
import { randomUUID } from "node:crypto";
import { getSessionUser } from "../../../lib/auth.ts";
import { privateJson, toBranchDto } from "../../../lib/api-contracts.ts";
import { getDatabase, runtimeEnv } from "../../../lib/db.ts";
import { requireApiPermission } from "../../../lib/rbac.ts";
const kinds = ["national", "state", "territory", "constituent"];
const parentKinds: Record<string, string[]> = {
  state: ["national"],
  territory: ["national"],
  constituent: ["state", "territory"],
};
function parentKindError(kind: string, parent: Record<string, any> | null) {
  if (!parent || !parentKinds[kind]) return null;
  return parentKinds[kind]!.includes(String(parent.kind))
    ? null
    : `A ${kind} branch must sit under a ${parentKinds[kind]!.join(" or ")} branch.`;
}
export const prerender = false;
export const GET: APIRoute = async ({ request, locals }) => {
  const env = runtimeEnv(locals);
  const user = await getSessionUser(request, env);
  const denied = requireApiPermission(user, "branches.manage", {
    message: "Administrator access required.",
  });
  if (denied || !user) return denied ?? Response.json({ error: "Sign in required." }, { status: 401 });
  const rows = await (
    await getDatabase(env)
  )
    .collection("branches")
    .find({})
    .sort({ name: 1 })
    .toArray();
  return privateJson({ branches: rows.map(toBranchDto) });
};
export const POST: APIRoute = async ({ request, locals }) => {
  const env = runtimeEnv(locals);
  const user = await getSessionUser(request, env);
  const denied = requireApiPermission(user, "branches.manage", {
    message: "Administrator access required.",
  });
  if (denied || !user) return denied ?? Response.json({ error: "Sign in required." }, { status: 401 });
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const branchId =
      typeof body.branchId === "string" ? body.branchId.trim() : randomUUID();
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const kind = typeof body.kind === "string" ? body.kind : "";
    const parentBranchId =
      typeof body.parentBranchId === "string" && body.parentBranchId.trim()
        ? body.parentBranchId.trim()
        : undefined;
    if (!name || name.length > 120 || !kinds.includes(kind))
      return Response.json(
        {
          error:
            "A name (1–120 characters) and valid branch kind are required.",
        },
        { status: 400 },
      );
    const db = await getDatabase(env);
    const existing = await db.collection("branches").findOne({ branchId });
    if (existing)
      return Response.json(
        { error: "A branch with this identifier already exists." },
        { status: 409 },
      );
    if (kind === "national" && parentBranchId)
      return Response.json(
        { error: "National branches cannot have a parent." },
        { status: 400 },
      );
    const parentRecord = parentBranchId
      ? await db.collection("branches").findOne({ branchId: parentBranchId })
      : null;
    if (parentBranchId && !parentRecord)
      return Response.json(
        { error: "Parent branch not found." },
        { status: 400 },
      );
    const createKindError = parentKindError(kind, parentRecord);
    if (createKindError)
      return Response.json({ error: createKindError }, { status: 400 });
    const record = {
      branchId,
      name,
      kind,
      ...(parentBranchId ? { parentBranchId } : {}),
      recognised: body.recognised === true,
      createdAt: new Date(),
      updatedBy: user.memberId,
    };
    await db.collection("branches").insertOne(record);
    await db
      .collection("branch_events")
      .insertOne({
        eventId: randomUUID(),
        branchId,
        action: "created",
        actorId: user.memberId,
        snapshot: record,
        createdAt: record.createdAt,
      });
    return privateJson({ branch: toBranchDto(record) }, { status: 201 });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "Could not create branch.",
      },
      { status: 400 },
    );
  }
};

export const PATCH: APIRoute = async ({ request, locals }) => {
  const env = runtimeEnv(locals);
  const user = await getSessionUser(request, env);
  const denied = requireApiPermission(user, "branches.manage", {
    message: "Administrator access required.",
  });
  if (denied || !user) return denied ?? Response.json({ error: "Sign in required." }, { status: 401 });
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const branchId =
      typeof body.branchId === "string" ? body.branchId.trim() : "";
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const kind = typeof body.kind === "string" ? body.kind : "";
    const parentBranchId =
      typeof body.parentBranchId === "string" && body.parentBranchId.trim()
        ? body.parentBranchId.trim()
        : null;
    if (!branchId || !name || name.length > 120 || !kinds.includes(kind))
      return Response.json(
        {
          error:
            "A branch ID, name (1–120 characters) and valid branch kind are required.",
        },
        { status: 400 },
      );
    const db = await getDatabase(env);
    const branches = db.collection("branches");
    const previous = await branches.findOne({ branchId });
    if (!previous)
      return Response.json({ error: "Branch not found." }, { status: 404 });
    if (kind === "national" && parentBranchId)
      return Response.json(
        { error: "National branches cannot have a parent." },
        { status: 400 },
      );
    if (parentBranchId) {
      let cursor: string | null = parentBranchId;
      const seen = new Set<string>();
      while (cursor) {
        if (cursor === branchId)
          return Response.json(
            { error: "A branch cannot be its own ancestor." },
            { status: 400 },
          );
        if (seen.has(cursor))
          return Response.json(
            {
              error:
                "The existing branch hierarchy contains a cycle and needs review.",
            },
            { status: 409 },
          );
        seen.add(cursor);
        const parent: any = await branches.findOne({ branchId: cursor });
        if (!parent)
          return Response.json(
            { error: "Parent branch not found." },
            { status: 400 },
          );
        cursor =
          typeof parent.parentBranchId === "string"
            ? parent.parentBranchId
            : null;
      }
    }
    const patchParent = parentBranchId
      ? await branches.findOne({ branchId: parentBranchId })
      : null;
    const patchKindError = parentKindError(kind, patchParent);
    if (patchKindError)
      return Response.json({ error: patchKindError }, { status: 400 });
    const next = {
      name,
      kind,
      parentBranchId,
      recognised: body.recognised === true,
      updatedAt: new Date(),
      updatedBy: user.memberId,
    };
    const compare = previous.updatedAt
      ? { branchId, updatedAt: previous.updatedAt }
      : { branchId, createdAt: previous.createdAt };
    const result = await branches.updateOne(compare, { $set: next });
    if (!result.matchedCount)
      return Response.json(
        {
          error:
            "Branch changed while you were editing it. Reload and try again.",
        },
        { status: 409 },
      );
    await db
      .collection("branch_events")
      .insertOne({
        eventId: randomUUID(),
        branchId,
        action: "updated",
        actorId: user.memberId,
        before: previous,
        after: next,
        createdAt: next.updatedAt,
      });
    return privateJson({ branch: toBranchDto({ ...previous, ...next }) });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "Could not update branch.",
      },
      { status: 400 },
    );
  }
};
