import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ObjectId } from "mongodb";
import {
  BranchParticipationError,
  chooseBranchMembership,
  ensureNationalMembership,
} from "./branch-participation.ts";
import { createMemoryDb } from "./db.ts";
import { verifyMemberFromCrm } from "./membership-verification.ts";
import { ALL_NATIONAL_PERMISSIONS } from "./rbac.ts";
import { saveMember } from "./store.ts";
import type { SessionUser } from "./types.ts";

const memberUser: SessionUser = {
  memberId: "mem-crm-1",
  name: "CRM Member",
  email: "crm-member@fusionparty.org.au",
  status: "verified",
  role: "member",
  roles: ["member"],
  permissions: { national: [], branches: {}, grants: [] },
  canParticipate: true,
  isStaff: false,
  isAdmin: false,
  isBranchAdmin: false,
  branchAdminIds: [],
  activeBranchIds: ["branch-nat"],
};

const adminUser: SessionUser = {
  ...memberUser,
  memberId: "admin-1",
  name: "National Admin",
  role: "administrator",
  roles: ["administrator"],
  permissions: { national: ALL_NATIONAL_PERMISSIONS, branches: {}, grants: [] },
  isStaff: true,
  isAdmin: true,
};

describe("Sprint 1 membership and CRM invariants (#32)", () => {
  it("blocks self-service branch switching from revoking an underground-crm membership", async () => {
    const db = createMemoryDb();
    await db.collection("branches").insertOne({ branchId: "vic", name: "Victoria", kind: "state", recognised: true });
    await db.collection("branches").insertOne({ branchId: "nsw", name: "New South Wales", kind: "state", recognised: true });
    await db.collection("branch_memberships").insertOne({
      branchId: "vic",
      memberId: memberUser.memberId,
      status: "active",
      branchRole: "member",
      source: "underground-crm",
      verifiedAt: new Date(),
    });

    await assert.rejects(
      chooseBranchMembership(db, memberUser, {
        branchId: "nsw",
        join: true,
        resident: true,
      }),
      (err: unknown) =>
        err instanceof BranchParticipationError &&
        err.status === 409 &&
        err.code === "external-membership-source",
    );

    // Original CRM membership remains active
    const vic = await db
      .collection("branch_memberships")
      .findOne({ branchId: "vic", memberId: memberUser.memberId });
    assert.equal(vic?.status, "active");
  });

  it("does not trigger branch_conflict when national membership exists alongside CRM geographic assignment", async () => {
    const db = createMemoryDb();
    const userId = new ObjectId();
    const memberId = String(userId);
    await db.collection("user").insertOne({
      _id: userId,
      name: "National + CRM Member",
      email: "nat-crm@fusionparty.org.au",
      emailVerified: true,
    });
    await db.collection("branches").insertOne({ branchId: "branch-nat", name: "National", kind: "national", recognised: true });
    await db.collection("branches").insertOne({ branchId: "vic", name: "Victoria", kind: "state", recognised: true });

    // Simulate sign-in creating the national row
    await ensureNationalMembership(db, memberId);

    const FUSION_TYPE = "7c0e1f52-8a3d-4a7d-9b5e-2f6d1c8a4e10";
    const mockFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("email=")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "crm-p-1",
                email: "nat-crm@fusionparty.org.au",
                email_is_bad: false,
                first_name: "National",
                last_name: "Member",
                preferred_name: "",
                full_name: "National + CRM Member",
                record_type: "person",
                is_active: true,
                is_deceased: false,
                federal_district: "Cooper",
                updated_at: "2026-11-13T00:00:00+11:00",
                memberships: [
                  {
                    id: "mem-1",
                    type_id: FUSION_TYPE,
                    type_name: "Fusion member",
                    started_at: "2026-01-01T00:00:00+11:00",
                    expires_on: "2027-01-01",
                    suspended_at: null,
                    status: "active",
                    is_active: true,
                  },
                ],
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("Not found", { status: 404 });
    };

    const outcome = await verifyMemberFromCrm(
      db,
      {
        ENGAGE_CRM_BASE_URL: "https://crm.example.test",
        ENGAGE_CRM_TOKEN: "engage-test-token-2d4c8a1f6b9e4a7c8d3f5e2b1a9c7d4e",
        ENGAGE_CRM_FUSION_MEMBERSHIP_TYPE_ID: FUSION_TYPE,
        ENGAGE_CRM_ELECTORATE_BRANCH_MAP: JSON.stringify({
          federal_district: { Cooper: "vic" },
        }),
      },
      memberId,
      { fetchImpl: mockFetch },
    );

    assert.equal(outcome.kind, "verified");
    const vicMembership = await db
      .collection("branch_memberships")
      .findOne({ memberId, branchId: "vic" });
    assert.equal(vicMembership?.status, "active");
    assert.equal(vicMembership?.source, "underground-crm");

    const conflicts = await db
      .collection("membership_verification_reviews")
      .countDocuments({ memberId, reason: "branch_conflict" });
    assert.equal(conflicts, 0);
  });

  it("records verifiedBy and verificationSource on manual admin verification", async () => {
    const db = createMemoryDb();
    const userId = new ObjectId();
    const memberId = String(userId);
    await db.collection("user").insertOne({
      _id: userId,
      name: "Manual Member",
      email: "manual@fusionparty.org.au",
    });
    await db.collection("memberships").insertOne({
      memberId,
      status: "pending",
    });

    await saveMember(db, adminUser, {
      memberId,
      status: "verified",
    });

    const membership = await db.collection("memberships").findOne({ memberId });
    assert.equal(membership?.status, "verified");
    assert.equal(membership?.verifiedBy, adminUser.memberId);
    assert.equal(membership?.verificationSource, "manual-admin");
    assert.ok(membership?.verifiedAt instanceof Date);
  });
});
