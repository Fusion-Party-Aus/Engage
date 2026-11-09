import type { APIRoute } from "astro";
import { getSessionUser, canAdministerBranch } from "../../../../lib/auth.ts";
import { getDatabase, runtimeEnv } from "../../../../lib/db.ts";
import { listMembers, listProposals } from "../../../../lib/store.ts";
import { BRANCH_MEMBERSHIPS, BRANCH_SUBSCRIPTIONS } from "../../../../lib/branch-participation.ts";

export const prerender = false;

/**
 * Typeahead for the branch workspace.
 *  - type=member: people already connected to the administrator's branches, or
 *    every verified member for a national administrator.
 *  - type=proposal: proposals to refer (national administrators only).
 * Results are capped and return only what a picker needs.
 */
export const GET: APIRoute = async ({ request, url, locals }) => {
  const env = runtimeEnv(locals);
  const user = await getSessionUser(request, env);
  if (!user)
    return Response.json({ error: "Sign in required." }, { status: 401 });
  if (!user.isAdmin && !user.isBranchAdmin)
    return Response.json(
      { error: "Branch administrator access required." },
      { status: 403 },
    );
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 80);
  const type = url.searchParams.get("type");
  const branchId = url.searchParams.get("branchId") ?? "";
  const db = await getDatabase(env);
  const headers = { "cache-control": "private, no-store" };

  if (type === "member") {
    if (q.length < 2) return Response.json({ results: [] }, { headers });
    const branches = user.isAdmin
      ? branchId
        ? [branchId]
        : (
            await db
              .collection("branches")
              .find({})
              .project({ branchId: 1 })
              .toArray()
          ).map((row: any) => String(row.branchId))
      : branchId
        ? [branchId]
        : (user.branchAdminIds ?? []);
    if (!user.isAdmin && branchId && !canAdministerBranch(user, branchId))
      return Response.json(
        { error: "You are not authorised to search this branch." },
        { status: 403 },
      );
    if (!user.isAdmin && !branches.length)
      return Response.json({ results: [] }, { headers });

    const [subscriptions, memberships] = await Promise.all([
      db
        .collection(BRANCH_SUBSCRIPTIONS)
        .find({ branchId: { $in: branches }, status: "following" })
        .project({ memberId: 1 })
        .toArray(),
      db
        .collection(BRANCH_MEMBERSHIPS)
        .find({ branchId: { $in: branches }, status: "active" })
        .project({ memberId: 1 })
        .toArray(),
    ]);
    const allowed = new Set([
      ...subscriptions.map((row: any) => String(row.memberId)),
      ...memberships.map((row: any) => String(row.memberId)),
    ]);
    const members = (await listMembers(db, q))
      .filter(
        (member) =>
          member.status === "verified" &&
          !member.disabled &&
          (user.isAdmin || allowed.has(member.memberId)),
      )
      .slice(0, 8);
    return Response.json(
      {
        results: members.map((member) => ({
          id: member.memberId,
          label: member.name || "Name not provided",
          detail: member.email,
        })),
      },
      { headers },
    );
  }

  if (type === "proposal") {
    if (!user.isAdmin)
      return Response.json(
        { error: "Only a national administrator can refer proposals." },
        { status: 403 },
      );
    if (q.length < 2) return Response.json({ results: [] }, { headers });
    const proposals = (
      await listProposals(db, { includeArchived: false, search: q })
    ).slice(0, 8);
    return Response.json(
      {
        results: proposals.map((proposal) => ({
          id: proposal.proposalId,
          label: proposal.title,
          detail: `${proposal.proposalId} · ${proposal.space}`,
        })),
      },
      { headers },
    );
  }

  return Response.json({ error: "Unknown search type." }, { status: 400 });
};
