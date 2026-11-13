import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import type { Db } from "mongodb";
import { createMemoryDb } from "./db.ts";
import {
  BRANCH_SUBSCRIPTIONS,
  setBranchFollowing,
} from "./branch-participation.ts";
import {
  CRM_IDENTITY_LINKS,
  type CrmMembershipFact,
  type CrmPerson,
  readUndergroundCrmConfig,
} from "./underground-crm.ts";
import {
  REVIEW_REASON_LABELS,
  VERIFICATION_ATTEMPTS,
  VERIFICATION_EVENTS,
  VERIFICATION_REVIEWS,
  backfillRegistrationAttempts,
  enqueueVerificationAttempt,
  listOpenVerificationReviews,
  processDueVerificationAttempts,
  reconcileLinkedMembers,
  resolveOpenVerificationReviews,
  verifyMemberFromCrm,
} from "./membership-verification.ts";

const FUSION_MEMBERSHIP_TYPE = "7c0e1f52-8a3d-4a7d-9b5e-2f6d1c8a4e10";
const OTHER_MEMBERSHIP_TYPE = "c3f4a2b1-6d5e-4c8a-9f7b-1e2d3c4b5a60";
const VIC_BRANCH = "branch-vic";
const NSW_BRANCH = "branch-nsw";
const CONSTITUENT_BRANCH = "branch-vic-local";
const BASE_URL = "https://crm.example.org";
const TOKEN = "engage-test-token-2d4c8a1f6b9e4a7c8d3f5e2b1a9c7d4e";
const FIXED_NOW = new Date("2026-11-13T00:00:00.000Z");

function env(overrides: Record<string, string> = {}) {
  return {
    ENGAGE_CRM_BASE_URL: BASE_URL,
    ENGAGE_CRM_TOKEN: TOKEN,
    ENGAGE_CRM_FUSION_MEMBERSHIP_TYPE_ID: FUSION_MEMBERSHIP_TYPE,
    ENGAGE_CRM_ELECTORATE_BRANCH_MAP: JSON.stringify({
      federal_district: {
        Cooper: VIC_BRANCH,
        Warringah: NSW_BRANCH,
      },
      state_upper_district: {
        "Northern Metropolitan Region": VIC_BRANCH,
        "Western Metropolitan Region": VIC_BRANCH,
      },
      state_lower_district: {
        Richmond: VIC_BRANCH,
      },
      council_district: {
        "City of Yarra": VIC_BRANCH,
      },
      ward: {
        Melbourne: VIC_BRANCH,
      },
    }),
    ENGAGE_CRM_OUTAGE_ALERT_AFTER_ATTEMPTS: "3",
    ENGAGE_CRM_RECONCILE_INTERVAL_MINUTES: "1440",
    ...overrides,
  };
}

function membership(
  id: string,
  typeId: string,
  options: { active?: boolean; status?: CrmMembershipFact["status"] } = {},
): CrmMembershipFact {
  const active = options.active ?? true;
  const status = options.status ?? (active ? "active" : "expired");
  return {
    id,
    type_id: typeId,
    type_name:
      typeId === FUSION_MEMBERSHIP_TYPE ? "Fusion member" : "Other member",
    started_at: "2026-01-01T00:00:00+11:00",
    expires_on: active ? "2027-01-01" : "2025-12-31",
    suspended_at: status === "suspended" ? "2026-11-01T00:00:00+11:00" : null,
    status,
    is_active: active,
  };
}

function crmPerson(
  id: string,
  email: string,
  options: {
    memberships?: CrmMembershipFact[];
    federal?: string;
    stateUpper?: string;
    stateLower?: string;
    council?: string;
    ward?: string;
    recordType?: "person" | "organisation";
    active?: boolean;
    deceased?: boolean;
    emailBad?: boolean;
  } = {},
): CrmPerson {
  return {
    id,
    email,
    email_is_bad: options.emailBad ?? false,
    first_name: "Test",
    last_name: "Member",
    preferred_name: "",
    full_name: "Test Member",
    record_type: options.recordType ?? "person",
    is_active: options.active ?? true,
    is_deceased: options.deceased ?? false,
    federal_district: options.federal ?? "Cooper",
    state_upper_district: options.stateUpper ?? "Northern Metropolitan Region",
    state_lower_district: options.stateLower ?? "Richmond",
    council_district: options.council ?? "City of Yarra",
    ward: options.ward ?? "Melbourne",
    updated_at: "2026-11-13T00:00:00+11:00",
    memberships: options.memberships ?? [
      membership("crm-membership-1", FUSION_MEMBERSHIP_TYPE, { active: true }),
    ],
  };
}

function fakeCrm(options: {
  byEmail?: CrmPerson[];
  byId?: Record<string, CrmPerson | null>;
  status?: number;
  error?: boolean;
  onCall?: (url: URL) => void;
}) {
  return (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    options.onCall?.(url);
    if (options.error) throw new Error("connection refused");
    if (options.status) {
      return new Response("upstream failure", { status: options.status });
    }
    const email = url.searchParams.get("email");
    if (email) {
      return Response.json({ data: options.byEmail ?? [] });
    }
    const match = url.pathname.match(/\/people\/([^/]+)\/$/);
    if (match) {
      const person = options.byId?.[decodeURIComponent(match[1]!)];
      if (!person) return new Response("not found", { status: 404 });
      return Response.json({ data: person });
    }
    return Response.json({ data: [] });
  }) as typeof fetch;
}

async function seededDb(): Promise<{
  db: Db;
  adminId: string;
  memberId: string;
  memberEmail: string;
}> {
  const db = createMemoryDb();
  await db.collection("branches").insertOne({
    branchId: "branch-nat",
    name: "Fusion National",
    kind: "national",
    recognised: true,
  });
  await db.collection("branches").insertOne({
    branchId: VIC_BRANCH,
    name: "Fusion Victoria",
    kind: "state",
    parentBranchId: "branch-nat",
    recognised: true,
  });
  await db.collection("branches").insertOne({
    branchId: NSW_BRANCH,
    name: "Fusion New South Wales",
    kind: "state",
    parentBranchId: "branch-nat",
    recognised: true,
  });
  await db.collection("branches").insertOne({
    branchId: CONSTITUENT_BRANCH,
    name: "Fusion Melbourne",
    kind: "constituent",
    parentBranchId: VIC_BRANCH,
    recognised: true,
  });

  const adminObjectId = new ObjectId();
  await db.collection("user").insertOne({
    _id: adminObjectId as any,
    name: "National Administrator",
    email: "admin@example.org",
    emailVerified: true,
    createdAt: FIXED_NOW,
  });
  await db.collection("application_roles").insertOne({
    memberId: String(adminObjectId),
    role: "administrator",
  });

  const memberObjectId = new ObjectId();
  const memberEmail = "priya.sharma@example.org";
  await db.collection("user").insertOne({
    _id: memberObjectId as any,
    name: "Priya Sharma",
    email: memberEmail,
    emailVerified: true,
    createdAt: FIXED_NOW,
  });
  await db.collection("memberships").insertOne({
    memberId: String(memberObjectId),
    status: "pending",
    createdAt: FIXED_NOW,
  });
  return {
    db,
    adminId: String(adminObjectId),
    memberId: String(memberObjectId),
    memberEmail,
  };
}

async function openReviewCount(db: Db, memberId: string): Promise<number> {
  return db
    .collection(VERIFICATION_REVIEWS)
    .countDocuments({ memberId, status: "open" });
}

async function adminNotificationCount(db: Db, adminId: string): Promise<number> {
  return db
    .collection("member_notifications")
    .countDocuments({ memberId: adminId });
}

describe("Underground CRM verification configuration", () => {
  it("reads the membership type and Engage-owned electorate mapping", () => {
    const config = readUndergroundCrmConfig(env());
    assert.equal(config.baseUrl, BASE_URL);
    assert.ok(config.fusionMembershipTypeIds.has(FUSION_MEMBERSHIP_TYPE));
    assert.equal(
      config.electorateBranchMap.get("federal_district")?.get("cooper"),
      VIC_BRANCH,
    );
    assert.throws(
      () => readUndergroundCrmConfig(env({ ENGAGE_CRM_FUSION_MEMBERSHIP_TYPE_ID: "" })),
      /FUSION_MEMBERSHIP_TYPE_ID/,
    );
    assert.throws(
      () => readUndergroundCrmConfig(env({ ENGAGE_CRM_ELECTORATE_BRANCH_MAP: "{nope" })),
      /valid JSON/,
    );
    assert.throws(
      () =>
        readUndergroundCrmConfig(
          env({
            ENGAGE_CRM_ELECTORATE_BRANCH_MAP: JSON.stringify({
              not_a_field: { Cooper: VIC_BRANCH },
            }),
          }),
        ),
      /unknown field/,
    );
  });
});

describe("Automatic membership verification", () => {
  it("verifies an eligible member and assigns the mapped geographic branch", async () => {
    const { db, memberId, memberEmail } = await seededDb();
    await setBranchFollowing(db, memberId, VIC_BRANCH, true);
    const calls: string[] = [];
    const fetchImpl = fakeCrm({
      byEmail: [
        crmPerson("crm-person-priya", memberEmail, {
          memberships: [
            membership("crm-fusion-priya", FUSION_MEMBERSHIP_TYPE, {
              active: true,
            }),
          ],
        }),
      ],
      onCall: (url) => calls.push(url.pathname),
    });

    const outcome = await verifyMemberFromCrm(db, env(), memberId, {
      fetchImpl,
      now: FIXED_NOW,
      sendNotice: async () => "not-needed",
    });

    assert.equal(outcome.kind, "verified");
    if (outcome.kind !== "verified") return;
    assert.equal(outcome.branchId, VIC_BRANCH);
    assert.equal(outcome.branchOutcome, "assigned");

    const stored = await db.collection("memberships").findOne({ memberId });
    assert.equal(stored?.status, "verified");
    assert.equal(stored?.verificationSource, "underground-crm");
    assert.equal(stored?.externalPersonId, "crm-person-priya");
    assert.equal(stored?.verifiedBy, "system:underground-crm");

    const link = await db
      .collection(CRM_IDENTITY_LINKS)
      .findOne({ memberId });
    assert.equal(link?.crmPersonId, "crm-person-priya");
    assert.equal(link?.linkMethod, "verified-email");

    const branch = await db
      .collection("branch_memberships")
      .findOne({ memberId, branchId: VIC_BRANCH });
    assert.equal(branch?.status, "active");
    assert.equal(branch?.source, "underground-crm");
    assert.equal(branch?.externalMemberId, "crm-person-priya");

    const subscription = await db
      .collection(BRANCH_SUBSCRIPTIONS)
      .findOne({ memberId, branchId: VIC_BRANCH });
    assert.equal(
      subscription?.status,
      "following",
      "A verification must not overwrite the member's branch following preference.",
    );

    assert.equal(await openReviewCount(db, memberId), 0);
    assert.ok(
      calls.every((path) => path.startsWith("/api/integrations/v1/people/")),
      "The integration only reads the CRM people API.",
    );
    assert.ok(
      await db
        .collection(VERIFICATION_EVENTS)
        .findOne({ memberId, action: "membership-verified" }),
    );
  });

  it("leaves the member pending, opens one review and notifies administrators when no CRM person matches", async () => {
    const { db, adminId, memberId } = await seededDb();
    const outcome = await verifyMemberFromCrm(db, env(), memberId, {
      fetchImpl: fakeCrm({ byEmail: [] }),
      now: FIXED_NOW,
      sendNotice: async () => "not-needed",
    });
    assert.equal(outcome.kind, "review");
    if (outcome.kind === "review") assert.equal(outcome.reason, "unmatched");

    assert.equal(
      (await db.collection("memberships").findOne({ memberId }))?.status,
      "pending",
    );
    assert.equal(await openReviewCount(db, memberId), 1);
    assert.equal(await db.collection(CRM_IDENTITY_LINKS).countDocuments({}), 0);
    const notifications = await db
      .collection("member_notifications")
      .find({ memberId: adminId })
      .toArray();
    assert.equal(notifications.length, 1);
    assert.match(notifications[0]!.title, /review/i);
    assert.equal(
      await db
        .collection("member_notifications")
        .countDocuments({ memberId }),
      0,
      "The member is not sent an administrator review notification.",
    );
  });

  it("rejects an ambiguous CRM match without linking the account", async () => {
    const { db, memberId, memberEmail } = await seededDb();
    const outcome = await verifyMemberFromCrm(db, env(), memberId, {
      fetchImpl: fakeCrm({
        byEmail: [
          crmPerson("crm-person-a", memberEmail),
          crmPerson("crm-person-b", memberEmail),
        ],
      }),
      now: FIXED_NOW,
      sendNotice: async () => "not-needed",
    });
    assert.equal(outcome.kind, "review");
    if (outcome.kind === "review") assert.equal(outcome.reason, "ambiguous");
    assert.equal(await db.collection(CRM_IDENTITY_LINKS).countDocuments({}), 0);
    assert.equal(await openReviewCount(db, memberId), 1);
  });

  it("does not verify when the CRM membership is inactive or missing", async () => {
    for (const [label, memberships] of [
      [
        "expired",
        [
          membership("crm-fusion-expired", FUSION_MEMBERSHIP_TYPE, {
            active: false,
            status: "expired",
          }),
        ],
      ],
      [
        "missing",
        [membership("crm-other", OTHER_MEMBERSHIP_TYPE, { active: true })],
      ],
    ] as const) {
      const { db, memberId, memberEmail } = await seededDb();
      const outcome = await verifyMemberFromCrm(db, env(), memberId, {
        fetchImpl: fakeCrm({
          byEmail: [
            crmPerson("crm-person-priya", memberEmail, {
              memberships: [...memberships],
            }),
          ],
        }),
        now: FIXED_NOW,
        sendNotice: async () => "not-needed",
      });
      assert.equal(outcome.kind, "review", label);
      assert.equal(
        (await db.collection("memberships").findOne({ memberId }))?.status,
        "pending",
        label,
      );
      assert.equal(
        await db.collection(CRM_IDENTITY_LINKS).countDocuments({ memberId }),
        1,
        `${label}: the link is recorded so later reconciliation uses the UUID.`,
      );
    }
  });

  it("never overrides a suspended Engage membership", async () => {
    const { db, memberId, memberEmail } = await seededDb();
    await db
      .collection("memberships")
      .updateOne({ memberId }, { $set: { status: "suspended" } });
    const outcome = await verifyMemberFromCrm(db, env(), memberId, {
      fetchImpl: fakeCrm({
        byEmail: [crmPerson("crm-person-priya", memberEmail)],
      }),
      now: FIXED_NOW,
      sendNotice: async () => "not-needed",
    });
    assert.equal(outcome.kind, "review");
    if (outcome.kind === "review")
      assert.equal(outcome.reason, "suspended_membership");
    assert.equal(
      (await db.collection("memberships").findOne({ memberId }))?.status,
      "suspended",
    );
  });

  it("preserves an existing verified member and does not duplicate the verification event", async () => {
    const { db, memberId, memberEmail } = await seededDb();
    const person = crmPerson("crm-person-priya", memberEmail);
    await verifyMemberFromCrm(db, env(), memberId, {
      fetchImpl: fakeCrm({
        byEmail: [person],
        byId: { [person.id]: person },
      }),
      now: FIXED_NOW,
      sendNotice: async () => "not-needed",
    });
    const eventsBefore = await db
      .collection(VERIFICATION_EVENTS)
      .countDocuments({ memberId, action: "membership-verified" });

    const second = await verifyMemberFromCrm(db, env(), memberId, {
      fetchImpl: fakeCrm({
        byId: { [person.id]: person },
      }),
      now: new Date(FIXED_NOW.getTime() + 60_000),
      sendNotice: async () => "not-needed",
    });
    assert.equal(second.kind, "already_verified");
    assert.equal(
      await db
        .collection(VERIFICATION_EVENTS)
        .countDocuments({ memberId, action: "membership-verified" }),
      eventsBefore,
    );
    assert.equal(
      await db.collection("branch_memberships").countDocuments({ memberId }),
      1,
      "Re-verification is idempotent.",
    );
  });

  it("uses the durable CRM UUID after the email changes", async () => {
    const { db, memberId, memberEmail } = await seededDb();
    const person = crmPerson("crm-person-priya", memberEmail);
    await verifyMemberFromCrm(db, env(), memberId, {
      fetchImpl: fakeCrm({
        byEmail: [person],
        byId: { [person.id]: person },
      }),
      now: FIXED_NOW,
      sendNotice: async () => "not-needed",
    });

    await db
      .collection("user")
      .updateOne({ _id: new ObjectId(memberId) }, { $set: { email: "new@example.org" } });
    const changed = { ...person, email: "crm-new@example.org" };
    const outcome = await verifyMemberFromCrm(db, env(), memberId, {
      fetchImpl: fakeCrm({
        byEmail: [],
        byId: { [person.id]: changed },
      }),
      now: new Date(FIXED_NOW.getTime() + 60_000),
      sendNotice: async () => "not-needed",
    });
    assert.equal(outcome.kind, "already_verified");
    assert.equal(
      (await db.collection(CRM_IDENTITY_LINKS).findOne({ memberId }))?.crmPersonId,
      "crm-person-priya",
    );
  });

  it("verifies but asks for review when electorate fields map to different branches", async () => {
    const { db, memberId, memberEmail } = await seededDb();
    const person = crmPerson("crm-person-priya", memberEmail, {
      federal: "Cooper",
      stateLower: "Not Mapped",
    });
    // Add a conflicting mapping for a second field to exercise ambiguity.
    const ambiguousEnv = env({
      ENGAGE_CRM_ELECTORATE_BRANCH_MAP: JSON.stringify({
        federal_district: { Cooper: VIC_BRANCH },
        state_upper_district: {
          "Northern Metropolitan Region": NSW_BRANCH,
        },
      }),
    });
    const outcome = await verifyMemberFromCrm(db, ambiguousEnv, memberId, {
      fetchImpl: fakeCrm({ byEmail: [person] }),
      now: FIXED_NOW,
      sendNotice: async () => "not-needed",
    });
    assert.equal(outcome.kind, "verified");
    if (outcome.kind === "verified") {
      assert.equal(outcome.branchId, null);
      assert.equal(outcome.branchOutcome, "branch_ambiguous");
    }
    assert.equal(
      (await db.collection("memberships").findOne({ memberId }))?.status,
      "verified",
    );
    assert.equal(await openReviewCount(db, memberId), 1);
  });

  it("preserves a manually selected branch and opens a conflict review", async () => {
    const { db, memberId, memberEmail } = await seededDb();
    await db.collection("branch_memberships").insertOne({
      branchId: NSW_BRANCH,
      memberId,
      status: "active",
      branchRole: "member",
      source: "engage-local",
      verifiedAt: FIXED_NOW,
    });
    const outcome = await verifyMemberFromCrm(db, env(), memberId, {
      fetchImpl: fakeCrm({
        byEmail: [crmPerson("crm-person-priya", memberEmail)],
      }),
      now: FIXED_NOW,
      sendNotice: async () => "not-needed",
    });
    assert.equal(outcome.kind, "verified");
    if (outcome.kind === "verified") {
      assert.equal(outcome.branchId, null);
      assert.equal(outcome.branchOutcome, "branch_conflict");
    }
    const existing = await db
      .collection("branch_memberships")
      .findOne({ memberId, branchId: NSW_BRANCH });
    assert.equal(existing?.source, "engage-local");
    assert.equal(existing?.status, "active");
    assert.equal(await openReviewCount(db, memberId), 1);
  });

  it("does not assign a national or constituent branch automatically", async () => {
    const { db, memberId, memberEmail } = await seededDb();
    const outcome = await verifyMemberFromCrm(
      db,
      env({
        ENGAGE_CRM_ELECTORATE_BRANCH_MAP: JSON.stringify({
          federal_district: { Cooper: CONSTITUENT_BRANCH },
        }),
      }),
      memberId,
      {
        fetchImpl: fakeCrm({
          byEmail: [crmPerson("crm-person-priya", memberEmail)],
        }),
        now: FIXED_NOW,
        sendNotice: async () => "not-needed",
      },
    );
    assert.equal(outcome.kind, "verified");
    if (outcome.kind === "verified")
      assert.equal(outcome.branchOutcome, "branch_not_geographic");
    assert.equal(
      await db.collection("branch_memberships").countDocuments({ memberId }),
      0,
    );
    assert.equal(await openReviewCount(db, memberId), 1);
  });

  it("treats a CRM outage as retryable and never as a membership failure or revocation", async () => {
    const { db, adminId, memberId } = await seededDb();
    await enqueueVerificationAttempt(db, memberId, {
      source: "test",
      now: FIXED_NOW,
    });

    const first = await processDueVerificationAttempts(db, env(), {
      fetchImpl: fakeCrm({ status: 503 }),
      now: FIXED_NOW,
      sendNotice: async () => "not-needed",
    });
    assert.equal(first.retried, 1);
    assert.equal(
      (await db.collection("memberships").findOne({ memberId }))?.status,
      "pending",
    );
    assert.equal(await openReviewCount(db, memberId), 0);

    const second = await processDueVerificationAttempts(db, env(), {
      fetchImpl: fakeCrm({ status: 503 }),
      now: new Date(FIXED_NOW.getTime() + 6 * 60_000),
      sendNotice: async () => "not-needed",
    });
    assert.equal(second.retried, 1);
    const third = await processDueVerificationAttempts(db, env(), {
      fetchImpl: fakeCrm({ status: 503 }),
      now: new Date(FIXED_NOW.getTime() + 30 * 60_000),
      sendNotice: async () => "not-needed",
    });
    assert.equal(third.retried, 1);
    assert.equal(
      await db
        .collection("member_notifications")
        .countDocuments({ memberId: adminId, title: /CRM membership checks delayed/ }),
      1,
      "The outage alert is deduplicated for the day.",
    );

    // A later successful run must verify normally.
    const recovery = await processDueVerificationAttempts(db, env(), {
      fetchImpl: fakeCrm({
        byEmail: [crmPerson("crm-person-priya", "priya.sharma@example.org")],
      }),
      now: new Date(FIXED_NOW.getTime() + 2 * 60 * 60_000),
      sendNotice: async () => "not-needed",
    });
    assert.equal(recovery.verified, 1);
    assert.equal(
      (await db.collection("memberships").findOne({ memberId }))?.status,
      "verified",
    );
  });

  it("never revokes a verified member when reconciliation finds the CRM membership inactive", async () => {
    const { db, memberId, memberEmail } = await seededDb();
    const active = crmPerson("crm-person-priya", memberEmail);
    await verifyMemberFromCrm(db, env(), memberId, {
      fetchImpl: fakeCrm({ byEmail: [active] }),
      now: FIXED_NOW,
      sendNotice: async () => "not-needed",
    });
    assert.equal(
      (await db.collection("memberships").findOne({ memberId }))?.status,
      "verified",
    );

    const inactive = crmPerson("crm-person-priya", memberEmail, {
      memberships: [
        membership("crm-fusion-priya", FUSION_MEMBERSHIP_TYPE, {
          active: false,
          status: "expired",
        }),
      ],
    });
    const outcome = await verifyMemberFromCrm(db, env(), memberId, {
      fetchImpl: fakeCrm({ byId: { [inactive.id]: inactive } }),
      now: new Date(FIXED_NOW.getTime() + 60_000),
      sendNotice: async () => "not-needed",
    });
    assert.equal(outcome.kind, "review");
    if (outcome.kind === "review")
      assert.equal(outcome.reason, "membership_inactive");
    assert.equal(
      (await db.collection("memberships").findOne({ memberId }))?.status,
      "verified",
      "Reconciliation does not revoke an existing verified member.",
    );
  });

  it("lists and resolves open reviews for the administrator interface", async () => {
    const { db, adminId, memberId } = await seededDb();
    await verifyMemberFromCrm(db, env(), memberId, {
      fetchImpl: fakeCrm({ byEmail: [] }),
      now: FIXED_NOW,
      sendNotice: async () => "not-needed",
    });
    const reviews = await listOpenVerificationReviews(db, 25);
    assert.equal(reviews.length, 1);
    assert.equal(reviews[0]?.memberId, memberId);
    assert.equal(reviews[0]?.reasonLabel, REVIEW_REASON_LABELS.unmatched);
    assert.equal(await adminNotificationCount(db, adminId), 1);

    const resolved = await resolveOpenVerificationReviews(db, memberId, {
      actorId: adminId,
      note: "Verified manually.",
      now: FIXED_NOW,
    });
    assert.equal(resolved, 1);
    assert.equal(await openReviewCount(db, memberId), 0);
    assert.equal((await listOpenVerificationReviews(db, 25)).length, 0);
  });

  it("reconciliation checks linked members and records an unavailable CRM without changing status", async () => {
    const { db, memberId, memberEmail } = await seededDb();
    const person = crmPerson("crm-person-priya", memberEmail);
    await verifyMemberFromCrm(db, env(), memberId, {
      fetchImpl: fakeCrm({ byEmail: [person] }),
      now: FIXED_NOW,
      sendNotice: async () => "not-needed",
    });
    await db.collection(CRM_IDENTITY_LINKS).updateOne(
      { memberId },
      { $set: { nextCheckAt: new Date(FIXED_NOW.getTime() - 60_000) } },
    );

    const report = await reconcileLinkedMembers(db, env(), {
      fetchImpl: fakeCrm({ status: 503 }),
      now: FIXED_NOW,
      sendNotice: async () => "not-needed",
    });
    assert.equal(report.checked, 1);
    assert.equal(report.retried, 1);
    assert.equal(
      (await db.collection("memberships").findOne({ memberId }))?.status,
      "verified",
    );
    assert.equal(await openReviewCount(db, memberId), 0);
  });

  it("records an inactive membership review without removing an existing branch fact", async () => {
    const { db, memberId, memberEmail } = await seededDb();
    const active = crmPerson("crm-person-priya", memberEmail);
    await verifyMemberFromCrm(db, env(), memberId, {
      fetchImpl: fakeCrm({ byEmail: [active] }),
      now: FIXED_NOW,
      sendNotice: async () => "not-needed",
    });
    const branchBefore = await db
      .collection("branch_memberships")
      .findOne({ memberId, branchId: VIC_BRANCH });
    const inactive = crmPerson("crm-person-priya", memberEmail, {
      federal: "",
      stateUpper: "",
      stateLower: "",
      council: "",
      ward: "",
      memberships: [
        membership("crm-fusion-priya", FUSION_MEMBERSHIP_TYPE, {
          active: false,
          status: "expired",
        }),
      ],
    });
    await verifyMemberFromCrm(db, env(), memberId, {
      fetchImpl: fakeCrm({ byId: { [inactive.id]: inactive } }),
      now: new Date(FIXED_NOW.getTime() + 60_000),
      sendNotice: async () => "not-needed",
    });
    const branchAfter = await db
      .collection("branch_memberships")
      .findOne({ memberId, branchId: VIC_BRANCH });
    assert.deepEqual(branchAfter, branchBefore);
    assert.equal(
      (await db.collection("memberships").findOne({ memberId }))?.status,
      "verified",
    );
  });

  it("uses the UUID detail endpoint after linking and does not call the email lookup again", async () => {
    const { db, memberId, memberEmail } = await seededDb();
    const person = crmPerson("crm-person-priya", memberEmail);
    const calls: URL[] = [];
    await verifyMemberFromCrm(db, env(), memberId, {
      fetchImpl: fakeCrm({
        byEmail: [person],
        byId: { [person.id]: person },
        onCall: (url) => calls.push(url),
      }),
      now: FIXED_NOW,
      sendNotice: async () => "not-needed",
    });
    calls.length = 0;
    await verifyMemberFromCrm(db, env(), memberId, {
      fetchImpl: fakeCrm({
        byEmail: [],
        byId: { [person.id]: person },
        onCall: (url) => calls.push(url),
      }),
      now: new Date(FIXED_NOW.getTime() + 60_000),
      sendNotice: async () => "not-needed",
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.searchParams.get("email"), null);
    assert.match(calls[0]?.pathname ?? "", new RegExp(`/people/${person.id}/$`));
  });

  it("never writes CRM membership or contact data", async () => {
    const { db, memberId, memberEmail } = await seededDb();
    const methods: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      methods.push(String(init?.method ?? "GET"));
      const url = new URL(String(input));
      if (url.searchParams.get("email")) {
        return Response.json({
          data: [crmPerson("crm-person-priya", memberEmail)],
        });
      }
      return Response.json({ data: [] });
    }) as typeof fetch;
    await verifyMemberFromCrm(db, env(), memberId, {
      fetchImpl,
      now: FIXED_NOW,
      sendNotice: async () => "not-needed",
    });
    assert.ok(methods.every((method) => method === "GET"));
  });
});


describe("Verification queue", () => {
  it("queues a registration once and backfills accounts without a membership document", async () => {
    const { db, memberId } = await seededDb();
    assert.equal(
      await enqueueVerificationAttempt(db, memberId, {
        source: "registration",
        now: FIXED_NOW,
      }),
      true,
    );
    assert.equal(
      await enqueueVerificationAttempt(db, memberId, {
        source: "registration",
        now: FIXED_NOW,
      }),
      false,
      "A duplicate registration hook must not create a second attempt.",
    );
    assert.equal(
      await db.collection(VERIFICATION_ATTEMPTS).countDocuments({ memberId }),
      1,
    );

    const noMembership = new ObjectId();
    await db.collection("user").insertOne({
      _id: noMembership as any,
      name: "Existing Pending Member",
      email: "existing@example.org",
      emailVerified: true,
    });
    const queued = await backfillRegistrationAttempts(db, {
      now: FIXED_NOW,
    });
    assert.ok(queued >= 1);
    assert.equal(
      await db
        .collection(VERIFICATION_ATTEMPTS)
        .countDocuments({ memberId: String(noMembership) }),
      1,
    );
  });
});
