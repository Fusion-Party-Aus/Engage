import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { ObjectId, type Db } from "mongodb";
import { createMemoryDb } from "./db.ts";
import {
  amendmentDeepLink,
  commentDeepLink,
  getMemberProfilePage,
  getMemberProfileSettings,
  memberInitials,
  memberProfileHref,
  normalizeMemberBio,
  profileCrmIdentifiersEnabled,
  resolveMemberProfileRoute,
  resolveMemberProfileLinks,
  saveMemberProfile,
  validateMemberBioInput,
  MEMBER_BIO_MAX_LENGTH,
  MEMBER_PROFILE_PAGE_SIZE,
} from "./member-profile.ts";
import type { SessionUser } from "./types.ts";

/**
 * Public member profiles (#113).
 *
 * These tests exercise the read model against the in-memory database. They
 * focus on what a profile must never reveal: content on proposals the viewer
 * cannot open, deleted comments, withdrawn amendments, private account fields
 * and comment voter identities.
 */

let db: Db;

const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, minute));

function session(
  memberId: string,
  overrides: Partial<SessionUser> = {},
): SessionUser {
  return {
    memberId,
    name: "Viewer",
    email: "viewer@example.org",
    role: "member",
    roles: ["member"],
    status: "verified",
    canParticipate: true,
    isStaff: false,
    isAdmin: false,
    activeBranchIds: [],
    verifiedBranchIds: [],
    followedBranchIds: [],
    branchAdminIds: [],
    ...overrides,
  };
}

interface Seed {
  ada: ObjectId;
  bob: ObjectId;
  disabled: ObjectId;
  missing: string;
}

async function insertAccount(
  id: ObjectId | string,
  values: Record<string, unknown>,
): Promise<void> {
  await db.collection("user").insertOne({ _id: id, ...values } as any);
}

async function insertProposal(values: Record<string, unknown>): Promise<void> {
  await db.collection("proposals").insertOne({
    space: "General",
    summary: "",
    outcomes: [],
    details: "",
    stage: "deliberate",
    kind: "policy",
    createdAt: at(0),
    updatedAt: at(0),
    ...values,
  });
}

async function insertComment(values: Record<string, unknown>): Promise<void> {
  await db.collection("comments").insertOne({
    stance: "comment",
    body: "Contribution",
    upvotes: [],
    downvotes: [],
    depth: 0,
    voteVersion: 0,
    createdAt: at(0),
    ...values,
  });
}

async function seed(): Promise<Seed> {
  const ada = new ObjectId();
  const bob = new ObjectId();
  const disabled = new ObjectId();
  const missing = "legacy-contributor-01";
  const adaId = ada.toHexString();
  const bobId = bob.toHexString();

  await Promise.all([
    insertAccount(ada, {
      name: "Ada Lovelace",
      email: "ada@example.org",
      bio: "Interested in transparent governance.",
      createdAt: new Date(Date.UTC(2025, 5, 1)),
      emailVerified: true,
      disabled: false,
    }),
    insertAccount(bob, {
      name: "Bob Member",
      email: "bob@example.org",
      createdAt: new Date(Date.UTC(2025, 6, 1)),
    }),
    insertAccount(disabled, {
      name: "Disabled Account",
      email: "disabled@example.org",
      disabled: true,
    }),
  ]);

  await Promise.all([
    insertProposal({
      proposalId: "PROP-PUBLIC",
      slug: "public-proposal",
      title: "Public proposal",
      summary: "A public summary",
      stage: "deliberate",
      authorId: adaId,
      authorName: "Ada Lovelace",
      createdAt: at(1),
    }),
    insertProposal({
      proposalId: "PROP-PRIVATE",
      slug: "secret-private-proposal",
      title: "Secret private proposal",
      summary: "Confidential",
      stage: "deliberate",
      publicationScope: "private",
      authorId: bobId,
      authorName: "Bob Member",
      createdAt: at(2),
    }),
    insertProposal({
      proposalId: "PROP-BRANCH",
      slug: "branch-proposal",
      title: "Branch proposal",
      summary: "Branch-scoped",
      stage: "deliberate",
      publicationScope: "branch",
      originatingBranchId: "vic",
      jurisdictionBranchId: "vic",
      authorId: bobId,
      authorName: "Bob Member",
      createdAt: at(3),
    }),
    insertProposal({
      proposalId: "PROP-ARCHIVED",
      slug: "archived-proposal",
      title: "Archived proposal",
      summary: "Old business",
      stage: "archived",
      authorId: adaId,
      authorName: "Ada Lovelace",
      createdAt: at(4),
    }),
  ]);

  await Promise.all([
    db.collection("branches").insertOne({
      branchId: "branch-nat",
      name: "Fusion National",
      kind: "national",
      recognised: true,
      createdAt: at(0),
    }),
    db.collection("branches").insertOne({
      branchId: "vic",
      name: "Victoria",
      kind: "state",
      recognised: true,
      createdAt: at(0),
    }),
    db.collection("branches").insertOne({
      branchId: "constituent-secret",
      name: "Internal affinity group",
      kind: "constituent",
      recognised: true,
      createdAt: at(0),
    }),
  ]);

  await Promise.all([
    db.collection("branch_memberships").insertOne({
      memberId: adaId,
      branchId: "branch-nat",
      status: "active",
      branchRole: "member",
    }),
    db.collection("branch_memberships").insertOne({
      memberId: adaId,
      branchId: "vic",
      status: "active",
      branchRole: "member",
    }),
    db.collection("branch_memberships").insertOne({
      memberId: adaId,
      branchId: "constituent-secret",
      status: "active",
      branchRole: "member",
    }),
  ]);

  await Promise.all([
    insertComment({
      commentId: "cmt-public-old",
      proposalId: "PROP-PUBLIC",
      memberId: adaId,
      authorName: "Ada Lovelace",
      stance: "support",
      body: "I support this because it is clear.",
      upvotes: ["voter-a", "voter-b"],
      createdAt: at(10),
    }),
    insertComment({
      commentId: "cmt-public-new",
      proposalId: "PROP-PUBLIC",
      memberId: adaId,
      parentCommentId: "cmt-public-old",
      depth: 1,
      authorName: "Ada Lovelace",
      stance: "concern",
      body: "One concern about sequencing.",
      upvotes: ["voter-a"],
      downvotes: ["voter-c"],
      createdAt: at(11),
    }),
    insertComment({
      commentId: "cmt-private",
      proposalId: "PROP-PRIVATE",
      memberId: adaId,
      authorName: "Ada Lovelace",
      stance: "comment",
      body: "Private deliberation text",
      upvotes: Array.from({ length: 50 }, (_, index) => `private-voter-${index}`),
      createdAt: at(12),
    }),
    insertComment({
      commentId: "cmt-branch",
      proposalId: "PROP-BRANCH",
      memberId: adaId,
      authorName: "Ada Lovelace",
      stance: "comment",
      body: "Branch members can see this.",
      upvotes: Array.from({ length: 10 }, (_, index) => `branch-voter-${index}`),
      createdAt: at(13),
    }),
    insertComment({
      commentId: "cmt-archived",
      proposalId: "PROP-ARCHIVED",
      memberId: adaId,
      authorName: "Ada Lovelace",
      stance: "comment",
      body: "Archived contribution",
      upvotes: Array.from({ length: 20 }, (_, index) => `archive-voter-${index}`),
      createdAt: at(14),
    }),
    insertComment({
      commentId: "cmt-deleted",
      proposalId: "PROP-PUBLIC",
      memberId: adaId,
      authorName: "Ada Lovelace",
      stance: "comment",
      body: "",
      deletedAt: at(16),
      upvotes: Array.from({ length: 30 }, (_, index) => `deleted-voter-${index}`),
      createdAt: at(15),
    }),
    insertComment({
      commentId: "cmt-legacy",
      proposalId: "PROP-PUBLIC",
      memberId: missing,
      authorName: "Legacy Contributor",
      stance: "comment",
      body: "Historic but still public.",
      createdAt: at(9),
    }),
  ]);

  await Promise.all([
    db.collection("amendment_revisions").insertOne({
      revisionId: "amendment-rev-public",
      amendmentId: "AMD-PUBLIC",
      parentRevisionId: null,
      authorId: adaId,
      createdAt: at(20),
      snapshot: { title: "Clarify the public timeline", summary: "..." },
      contentHash: "hash-public",
    }),
    db.collection("amendment_revisions").insertOne({
      revisionId: "amendment-rev-private",
      amendmentId: "AMD-PRIVATE",
      parentRevisionId: null,
      authorId: adaId,
      createdAt: at(21),
      snapshot: { title: "Secret amendment wording" },
      contentHash: "hash-private",
    }),
  ]);

  await Promise.all([
    db.collection("amendments").insertOne({
      amendmentId: "AMD-PUBLIC",
      proposalId: "PROP-PUBLIC",
      baseRevisionId: "rev-1",
      currentRevisionId: "amendment-rev-public",
      authorId: adaId,
      changes: { title: "Clarify the public timeline" },
      fields: ["title"],
      status: "proposed",
      createdAt: at(20),
    }),
    db.collection("amendments").insertOne({
      amendmentId: "AMD-PRIVATE",
      proposalId: "PROP-PRIVATE",
      baseRevisionId: "rev-1",
      currentRevisionId: "amendment-rev-private",
      authorId: adaId,
      changes: { title: "Secret amendment wording" },
      fields: ["title"],
      status: "proposed",
      createdAt: at(21),
    }),
    db.collection("amendments").insertOne({
      amendmentId: "AMD-WITHDRAWN",
      proposalId: "PROP-PUBLIC",
      baseRevisionId: "rev-1",
      currentRevisionId: "amendment-rev-public",
      authorId: adaId,
      changes: { title: "Withdrawn wording" },
      fields: ["title"],
      status: "withdrawn",
      createdAt: at(22),
    }),
    db.collection("amendments").insertOne({
      amendmentId: "AMD-BOB",
      proposalId: "PROP-PUBLIC",
      baseRevisionId: "rev-1",
      currentRevisionId: "amendment-rev-public",
      authorId: bobId,
      changes: { title: "Bob's amendment" },
      fields: ["title"],
      status: "proposed",
      createdAt: at(23),
    }),
  ]);

  return { ada, bob, disabled, missing };
}

beforeEach(() => {
  db = createMemoryDb();
});

describe("public profile header", () => {
  it("shows a public name, biography and geographic affiliation", async () => {
    const seeded = await seed();
    const page = await getMemberProfilePage(db, seeded.ada.toHexString(), {
      pageSize: 10,
    });
    assert.ok(page);
    assert.equal(page.profile.name, "Ada Lovelace");
    assert.equal(page.profile.initials, "AL");
    assert.equal(page.profile.visible, true);
    assert.equal(page.profile.bio, "Interested in transparent governance.");
    assert.deepEqual(page.profile.affiliations, ["National member", "Victoria"]);
    assert.equal(page.profile.href, memberProfileHref(seeded.ada.toHexString()));
    assert.deepEqual(page.profile.stats, {
      comments: 2,
      proposals: 1,
      amendments: 1,
      commentScore: 2,
    });
  });

  it("does not expose email, membership status, CRM ids or voter identities", async () => {
    const seeded = await seed();
    const page = await getMemberProfilePage(db, seeded.ada.toHexString(), {
      pageSize: 10,
    });
    assert.ok(page);
    const serialised = JSON.stringify(page);
    assert.equal(serialised.includes("ada@example.org"), false);
    assert.equal(serialised.includes("crm"), false);
    assert.equal(serialised.includes("upvotes"), false);
    assert.equal(serialised.includes("downvotes"), false);
    assert.equal(serialised.includes("voter-a"), false);
    assert.equal(serialised.includes("Secret private proposal"), false);
    assert.equal(serialised.includes("Private deliberation text"), false);
    assert.equal(serialised.includes("Archived proposal"), false);
    assert.equal(serialised.includes("Internal affinity group"), false);
  });

  it("returns null for an unknown member and for a disabled account", async () => {
    const seeded = await seed();
    assert.equal(await getMemberProfilePage(db, "does-not-exist"), null);
    assert.equal(
      await getMemberProfilePage(db, seeded.disabled.toHexString()),
      null,
    );
  });

  it("keeps historic contributions readable when the account record is gone", async () => {
    const seeded = await seed();
    const page = await getMemberProfilePage(db, seeded.missing);
    assert.ok(page);
    assert.equal(page.profile.name, "Legacy Contributor");
    assert.equal(page.profile.bio, "");
    assert.equal(page.profile.stats.comments, 1);
  });

  it("does not reveal a historic author whose only contribution is private", async () => {
    await seed();
    await insertComment({
      commentId: "cmt-private-only",
      proposalId: "PROP-PRIVATE",
      memberId: "private-only-contributor",
      authorName: "Private Only",
      body: "Visible only inside a private proposal.",
      createdAt: at(30),
    });
    assert.equal(
      await getMemberProfilePage(db, "private-only-contributor"),
      null,
    );
  });
});

describe("contribution visibility", () => {
  it("includes legacy comments keyed by policyId", async () => {
    const seeded = await seed();
    await insertComment({
      commentId: "cmt-legacy-key",
      policyId: "PROP-PUBLIC",
      memberId: seeded.ada.toHexString(),
      authorName: "Ada Lovelace",
      stance: "comment",
      body: "A legacy contribution keyed by policyId.",
      upvotes: ["voter-a"],
      createdAt: at(40),
    });
    const page = await getMemberProfilePage(db, seeded.ada.toHexString(), {
      tab: "comments",
      pageSize: 10,
    });
    assert.ok(page);
    assert.equal(page.pagination.total, 3);
    assert.deepEqual(
      page.items.map((item) => item.id),
      ["cmt-legacy-key", "cmt-public-new", "cmt-public-old"],
    );
    assert.equal(page.profile.stats.commentScore, 3);
  });

  it("excludes private, branch, archived and deleted comments for anonymous visitors", async () => {
    const seeded = await seed();
    const page = await getMemberProfilePage(db, seeded.ada.toHexString(), {
      tab: "comments",
      pageSize: 10,
    });
    assert.ok(page);
    assert.equal(page.pagination.total, 2);
    assert.deepEqual(
      page.items.map((item) => item.id),
      ["cmt-public-new", "cmt-public-old"],
    );
    assert.ok(page.items.every((item) => item.kind === "comment"));
    assert.equal(
      page.items[0]?.href,
      commentDeepLink("public-proposal", "cmt-public-new"),
    );
    assert.equal(page.items[0]?.kind === "comment" && page.items[0].isReply, true);
    assert.equal(page.profile.stats.commentScore, 2);
  });

  it("includes branch-scoped contributions and comment score for a member of that branch", async () => {
    const seeded = await seed();
    const viewer = session("viewer-carol", {
      activeBranchIds: ["vic"],
      verifiedBranchIds: ["vic"],
    });
    const page = await getMemberProfilePage(db, seeded.ada.toHexString(), {
      tab: "comments",
      pageSize: 10,
      viewer,
    });
    assert.ok(page);
    assert.equal(page.pagination.total, 3);
    assert.deepEqual(
      page.items.map((item) => item.id),
      ["cmt-branch", "cmt-public-new", "cmt-public-old"],
    );
    assert.equal(page.profile.stats.commentScore, 12);
    assert.equal(
      JSON.stringify(page).includes("Secret private proposal"),
      false,
    );
  });

  it("shows a private proposal's comments only to a viewer who can open it", async () => {
    const seeded = await seed();
    // Bob authored the private proposal, so the platform already shows him its
    // discussion. The profile must mirror that existing visibility, not widen it.
    const page = await getMemberProfilePage(db, seeded.ada.toHexString(), {
      tab: "comments",
      pageSize: 10,
      viewer: session(seeded.bob.toHexString()),
    });
    assert.ok(page);
    assert.equal(page.pagination.total, 4);
    assert.deepEqual(
      page.items.map((item) => item.id),
      ["cmt-branch", "cmt-private", "cmt-public-new", "cmt-public-old"],
    );
    const privateItem = page.items.find((item) => item.id === "cmt-private");
    assert.ok(privateItem?.kind === "comment");
    assert.equal(privateItem.proposalId, "PROP-PRIVATE");
  });

  it("shows archived proposals to the owner and staff but not anonymous visitors", async () => {
    const seeded = await seed();
    const anonymous = await getMemberProfilePage(db, seeded.ada.toHexString(), {
      tab: "proposals",
    });
    assert.ok(anonymous);
    assert.deepEqual(
      anonymous.items.map((item) => item.id),
      ["PROP-PUBLIC"],
    );

    const owner = await getMemberProfilePage(db, seeded.ada.toHexString(), {
      tab: "proposals",
      viewer: session(seeded.ada.toHexString()),
    });
    assert.ok(owner);
    assert.deepEqual(
      owner.items.map((item) => item.id),
      ["PROP-ARCHIVED", "PROP-PUBLIC"],
    );

    const staff = await getMemberProfilePage(db, seeded.ada.toHexString(), {
      tab: "proposals",
      viewer: session(seeded.bob.toHexString(), {
        role: "administrator",
        roles: ["member", "administrator"],
        isStaff: true,
        isAdmin: true,
      }),
    });
    assert.ok(staff);
    assert.deepEqual(
      staff.items.map((item) => item.id),
      ["PROP-ARCHIVED", "PROP-PUBLIC"],
    );
  });

  it("lists amendments with their current wording and excludes withdrawn ones", async () => {
    const seeded = await seed();
    const page = await getMemberProfilePage(db, seeded.ada.toHexString(), {
      tab: "amendments",
    });
    assert.ok(page);
    assert.equal(page.pagination.total, 1);
    assert.deepEqual(
      page.items.map((item) => item.id),
      ["AMD-PUBLIC"],
    );
    const item = page.items[0];
    assert.ok(item?.kind === "amendment");
    assert.equal(item.title, "Clarify the public timeline");
    assert.equal(item.href, amendmentDeepLink("public-proposal", "AMD-PUBLIC"));
    assert.equal(item.fieldCount, 1);
    assert.equal(JSON.stringify(page).includes("AMD-WITHDRAWN"), false);
  });

  it("paginates deterministically and clamps an out-of-range page", async () => {
    const seeded = await seed();
    for (let index = 0; index < 18; index += 1) {
      await insertComment({
        commentId: `cmt-page-${String(index).padStart(2, "0")}`,
        proposalId: "PROP-PUBLIC",
        memberId: seeded.ada.toHexString(),
        authorName: "Ada Lovelace",
        body: `Paginated contribution ${index}`,
        upvotes: [],
        createdAt: at(100 + index),
      });
    }
    const first = await getMemberProfilePage(db, seeded.ada.toHexString(), {
      tab: "comments",
      page: 1,
      pageSize: 5,
    });
    assert.ok(first);
    assert.equal(first.pagination.pageCount, 4);
    assert.equal(first.pagination.total, 20);
    assert.equal(first.items.length, 5);
    assert.deepEqual(
      first.items.map((item) => item.id),
      ["cmt-page-17", "cmt-page-16", "cmt-page-15", "cmt-page-14", "cmt-page-13"],
    );

    const last = await getMemberProfilePage(db, seeded.ada.toHexString(), {
      tab: "comments",
      page: 99,
      pageSize: 5,
    });
    assert.ok(last);
    assert.equal(last.pagination.page, 4);
    assert.equal(last.items.length, 5);
    assert.equal(last.pagination.hasNext, false);
    assert.equal(last.pagination.hasPrevious, true);

    const beyond = await getMemberProfilePage(db, seeded.ada.toHexString(), {
      tab: "proposals",
      page: 99,
    });
    assert.ok(beyond);
    assert.equal(beyond.pagination.page, 1);
    assert.equal(beyond.pagination.pageCount, 1);
  });

  it("defaults to comments and ignores an unknown tab", async () => {
    const seeded = await seed();
    const page = await getMemberProfilePage(db, seeded.ada.toHexString(), {
      tab: "nonsense",
    });
    assert.ok(page);
    assert.equal(page.tab, "comments");
    assert.equal(page.pagination.pageSize, MEMBER_PROFILE_PAGE_SIZE);
  });
});

describe("profile links", () => {
  it("resolves accounts and suppresses disabled accounts", async () => {
    const seeded = await seed();
    const links = await resolveMemberProfileLinks(db, [
      seeded.ada.toHexString(),
      seeded.disabled.toHexString(),
      "legacy-contributor-01",
      "no-such-member",
    ]);
    assert.equal(
      links.get(seeded.ada.toHexString())?.href,
      memberProfileHref(seeded.ada.toHexString()),
    );
    assert.equal(links.get(seeded.ada.toHexString())?.name, "Ada Lovelace");
    assert.equal(links.has(seeded.disabled.toHexString()), false);
    assert.equal(
      links.get("legacy-contributor-01")?.href,
      memberProfileHref("legacy-contributor-01"),
    );
    assert.equal(links.get("legacy-contributor-01")?.name, "");
    assert.equal(links.has("no-such-member"), true);
  });

  it("builds encoded profile and deep-link paths", () => {
    assert.equal(memberProfileHref("abc 123"), "/members/abc%20123/");
    assert.equal(
      commentDeepLink("policy review", "cmt-1"),
      "/proposals/policy%20review/#comment-cmt-1",
    );
    assert.equal(
      amendmentDeepLink("policy-review", "AMD-1"),
      "/proposals/policy-review/#amendment-AMD-1",
    );
    assert.equal(memberInitials("Ada Lovelace"), "AL");
    assert.equal(memberInitials("Prince"), "P");
    assert.equal(memberInitials(""), "M");
  });
});

describe("public profile settings", () => {
  it("lets the account owner save and read a biography", async () => {
    const seeded = await seed();
    const owner = session(seeded.ada.toHexString());
    const saved = await saveMemberProfile(db, owner, {
      bio: "  I care about\r\nclear process.  ",
    });
    assert.deepEqual(saved, {
      bio: "I care about\nclear process.",
      profileVisible: true,
    });
    assert.deepEqual(
      await getMemberProfileSettings(db, seeded.ada.toHexString()),
      {
        bio: "I care about\nclear process.",
        profileVisible: true,
      },
    );
  });

  it("lets the owner hide the profile and its author links", async () => {
    const seeded = await seed();
    const owner = session(seeded.ada.toHexString());
    const saved = await saveMemberProfile(db, owner, {
      profileVisible: false,
    });
    assert.equal(saved.profileVisible, false);

    assert.equal(
      await getMemberProfilePage(db, seeded.ada.toHexString()),
      null,
    );
    const preview = await getMemberProfilePage(
      db,
      seeded.ada.toHexString(),
      { viewer: owner },
    );
    assert.ok(preview);
    assert.equal(preview.profile.visible, false);
    assert.equal(
      (
        await resolveMemberProfileLinks(db, [seeded.ada.toHexString()])
      ).has(seeded.ada.toHexString()),
      false,
    );

    const visibleAgain = await saveMemberProfile(db, owner, {
      profileVisible: true,
    });
    assert.equal(visibleAgain.profileVisible, true);
    assert.ok(
      await getMemberProfilePage(db, seeded.ada.toHexString()),
    );
  });

  it("rejects an invalid visibility value", async () => {
    const seeded = await seed();
    await assert.rejects(
      saveMemberProfile(db, session(seeded.ada.toHexString()), {
        profileVisible: "yes",
      }),
      /Profile visibility must be on or off/,
    );
  });

  it("preserves settings omitted from a partial update", async () => {
    const seeded = await seed();
    const owner = session(seeded.ada.toHexString());

    await saveMemberProfile(db, owner, { profileVisible: false });
    const bioOnly = await saveMemberProfile(db, owner, {
      bio: "Biography only.",
    });
    assert.equal(bioOnly.profileVisible, false);
    assert.equal(bioOnly.bio, "Biography only.");

    const visibilityOnly = await saveMemberProfile(db, owner, {
      profileVisible: true,
    });
    assert.equal(visibilityOnly.bio, "Biography only.");
    assert.equal(visibilityOnly.profileVisible, true);
  });

  it("rejects overlong or control-character biographies without changing storage", async () => {
    const seeded = await seed();
    const owner = session(seeded.ada.toHexString());
    assert.throws(
      () => validateMemberBioInput("x".repeat(MEMBER_BIO_MAX_LENGTH + 1)),
      /500 characters or fewer/,
    );
    assert.throws(() => validateMemberBioInput("bad\u0000text"), /unsupported/);
    await assert.rejects(
      saveMemberProfile(db, owner, {
        bio: "x".repeat(MEMBER_BIO_MAX_LENGTH + 1),
      }),
      /500 characters or fewer/,
    );
    assert.equal(
      (await getMemberProfileSettings(db, seeded.ada.toHexString())).bio,
      "Interested in transparent governance.",
    );
  });

  it("does not save a profile for a missing account", async () => {
    await assert.rejects(
      saveMemberProfile(db, session("no-account"), { bio: "Hello" }),
      /Account record not found/,
    );
  });

  it("normalises a legacy biography read", () => {
    assert.equal(
      normalizeMemberBio(`  ${"x".repeat(MEMBER_BIO_MAX_LENGTH + 50)}  `),
      "x".repeat(MEMBER_BIO_MAX_LENGTH),
    );
    assert.equal(normalizeMemberBio(undefined), "");
  });
});

describe("CRM profile identifier seam", () => {
  it("is off by default and keeps the member id canonical", async () => {
    const seeded = await seed();
    const memberId = seeded.ada.toHexString();
    const route = await resolveMemberProfileRoute(db, memberId, {});
    assert.ok(route);
    assert.equal(route.canonicalIdentifier, memberId);
    assert.equal(route.redirect, null);
    assert.equal(profileCrmIdentifiersEnabled({}), false);

    const page = await getMemberProfilePage(db, memberId, {
      profileIdentifier: route.canonicalIdentifier,
    });
    assert.ok(page);
    assert.equal(page.profile.href, memberProfileHref(memberId));
  });

  it("redirects a member-id path to an active CRM identifier when enabled", async () => {
    const seeded = await seed();
    const memberId = seeded.ada.toHexString();
    const crmPersonId = "crm-person-ada";
    await db.collection("crm_identity_links").insertOne({
      linkId: "link-ada",
      memberId,
      crmPersonId,
      application: "underground-crm",
      status: "active",
      linkedAt: new Date(),
    });

    const env = { ENGAGE_PROFILE_CRM_IDENTIFIERS: "on" };
    assert.equal(profileCrmIdentifiersEnabled(env), true);

    const memberPath = await resolveMemberProfileRoute(db, memberId, env);
    assert.ok(memberPath);
    assert.equal(memberPath.memberId, memberId);
    assert.equal(memberPath.canonicalIdentifier, crmPersonId);
    assert.equal(memberPath.redirect, memberProfileHref(crmPersonId));

    const crmPath = await resolveMemberProfileRoute(db, crmPersonId, env);
    assert.ok(crmPath);
    assert.equal(crmPath.memberId, memberId);
    assert.equal(crmPath.canonicalIdentifier, crmPersonId);
    assert.equal(crmPath.redirect, null);

    const page = await getMemberProfilePage(db, memberId, {
      profileIdentifier: crmPath.canonicalIdentifier,
    });
    assert.ok(page);
    assert.equal(page.profile.href, memberProfileHref(crmPersonId));
  });

  it("ignores retired CRM links", async () => {
    const seeded = await seed();
    const memberId = seeded.ada.toHexString();
    await db.collection("crm_identity_links").insertOne({
      linkId: "link-retired",
      memberId,
      crmPersonId: "crm-person-retired",
      application: "underground-crm",
      status: "retired",
      linkedAt: new Date(),
    });
    const env = { ENGAGE_PROFILE_CRM_IDENTIFIERS: "on" };
    const route = await resolveMemberProfileRoute(db, memberId, env);
    assert.ok(route);
    assert.equal(route.canonicalIdentifier, memberId);
    assert.equal(route.redirect, null);
  });

  it("does not misroute a CRM id that collides with another member id", async () => {
    const seeded = await seed();
    const adaId = seeded.ada.toHexString();
    const bobId = seeded.bob.toHexString();
    await db.collection("crm_identity_links").insertOne({
      linkId: "link-collision",
      memberId: adaId,
      crmPersonId: bobId,
      application: "underground-crm",
      status: "active",
      linkedAt: new Date(),
    });

    const env = { ENGAGE_PROFILE_CRM_IDENTIFIERS: "on" };
    const adaRoute = await resolveMemberProfileRoute(db, adaId, env);
    assert.ok(adaRoute);
    // Ada keeps her member id as canonical rather than publishing Bob's id.
    assert.equal(adaRoute.canonicalIdentifier, adaId);
    assert.equal(adaRoute.redirect, null);

    // The colliding path is ambiguous, so it does not render either person.
    assert.equal(await resolveMemberProfileRoute(db, bobId, env), null);
  });
});
