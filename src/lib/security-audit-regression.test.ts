import test from "node:test";
import assert from "node:assert/strict";
import { canManageBranchBallot } from "./auth.ts";
import { renderPortableText } from "./portable-text.ts";
import { PATCH as patchMembers } from "../pages/api/admin/members.ts";
import { PATCH as patchSettings } from "../pages/api/admin/settings/index.ts";
import { GET as getBranchMemberships } from "../pages/api/admin/branches/memberships.ts";
import { GET as getProposalsCsv } from "../pages/api/admin/reports/proposals.csv.ts";
import { createDevSessionCookie } from "./auth.ts";
import type { SessionUser } from "./types.ts";

test("moderator + branch admin of branch-a cannot manage branch-b ballots", () => {
  const hybridUser: SessionUser = {
    memberId: "mod-branch-a",
    name: "Hybrid Moderator",
    email: "mod@example.test",
    role: "moderator",
    status: "verified",
    canParticipate: true,
    isStaff: true,
    isAdmin: false,
    branchAdminIds: ["branch-a"],
    isBranchAdmin: true,
  };

  assert.equal(
    canManageBranchBallot(hybridUser, {
      governanceAuthorityBranchId: "branch-a",
      jurisdictionBranchId: "branch-a",
    }),
    true,
  );
  assert.equal(
    canManageBranchBallot(hybridUser, {
      governanceAuthorityBranchId: "branch-b",
      jurisdictionBranchId: "branch-b",
    }),
    false,
  );
  assert.equal(
    canManageBranchBallot(hybridUser, {
      governanceAuthorityBranchId: "branch-nat",
      jurisdictionBranchId: "branch-nat",
    }),
    false,
  );
});

test("renderPortableText rejects protocol-relative links", () => {
  const html = renderPortableText("Visit [evil](//evil.example/phish) now.");
  assert.equal(html.includes('href="//evil.example'), false);
});

test("settings API rejects spoofed X-Forwarded-Origin header", async () => {
  const cookie = createDevSessionCookie("administrator");
  const req = new Request("https://engage.example.test/api/admin/settings", {
    method: "PATCH",
    headers: {
      cookie,
      origin: "https://evil.example",
      "x-forwarded-origin": "https://evil.example",
      "content-type": "application/json",
    },
    body: JSON.stringify({ section: "general", siteTitle: "Pwned" }),
  });

  const res = await patchSettings({
    request: req,
    url: new URL(req.url),
    locals: {
      env: {
        APP_MODE: "preview",
        PUBLIC_ORIGIN: "https://engage.example.test",
      },
    },
  } as never);

  assert.equal(res.status, 403);
});

test("members PATCH rejects anonymous, non-admin, and malformed memberId", async () => {
  const anonReq = new Request("https://engage.example.test/api/admin/members", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ memberId: "not-an-object-id", status: "verified" }),
  });
  const anonRes = await patchMembers({
    request: anonReq,
    locals: { env: { APP_MODE: "preview" } },
  } as never);
  assert.equal(anonRes.status, 401);

  const memberCookie = createDevSessionCookie("member");
  const memberReq = new Request("https://engage.example.test/api/admin/members", {
    method: "PATCH",
    headers: { cookie: memberCookie, "content-type": "application/json" },
    body: JSON.stringify({ memberId: "not-an-object-id", role: "administrator" }),
  });
  const memberRes = await patchMembers({
    request: memberReq,
    locals: { env: { APP_MODE: "preview" } },
  } as never);
  assert.equal(memberRes.status, 403);

  const adminCookie = createDevSessionCookie("administrator");
  const badIdReq = new Request("https://engage.example.test/api/admin/members", {
    method: "PATCH",
    headers: { cookie: adminCookie, "content-type": "application/json" },
    body: JSON.stringify({ memberId: "bad-id", status: "verified" }),
  });
  const badIdRes = await patchMembers({
    request: badIdReq,
    locals: { env: { APP_MODE: "preview" } },
  } as never);
  assert.equal(badIdRes.status, 400);
  const badIdBody = (await badIdRes.json()) as { error: string };
  assert.equal(badIdBody.error, "Choose a valid member account.");
});

test("branch endpoints enforce specific granular permissions rather than generic isBranchAdmin", async () => {
  const memberCookie = createDevSessionCookie("member");
  const memReq = new Request("https://engage.example.test/api/admin/branches/memberships", {
    headers: { cookie: memberCookie },
  });
  const memRes = await getBranchMemberships({
    request: memReq,
    url: new URL(memReq.url),
    locals: { env: { APP_MODE: "preview" } },
  } as never);
  assert.equal(memRes.status, 403);

  const csvReq = new Request("https://engage.example.test/api/admin/reports/proposals.csv", {
    headers: { cookie: memberCookie },
  });
  const csvRes = await getProposalsCsv({
    request: csvReq,
    url: new URL(csvReq.url),
    locals: { env: { APP_MODE: "preview" } },
  } as never);
  assert.equal(csvRes.status, 403);
});
