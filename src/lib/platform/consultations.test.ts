import test from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { createSubmission, reviewSubmission, validateSubmission } from "./consultations.ts";
import type { PlatformIdentity } from "./types.ts";

const syntheticMember: PlatformIdentity = {
  memberId: "preview-member-01",
  source: "synthetic",
  roles: ["member"],
};

const syntheticModerator: PlatformIdentity = {
  memberId: "preview-admin-01",
  source: "synthetic",
  roles: ["member", "moderator", "administrator"],
};

function createFakeDb(options: {
  roundPolicies?: string[];
  roundStatus?: string;
  opensAt?: Date;
  closesAt?: Date;
  revisionExists?: boolean;
}) {
  const submissions: Record<string, unknown>[] = [];
  const audits: Record<string, unknown>[] = [];
  const db = {
    submissions,
    audits,
    collection(name: string) {
      if (name === "consultation_rounds") {
        return {
          async findOne(query: Record<string, unknown>) {
            const status = options.roundStatus ?? "open";
            if (query.status && query.status !== status) return null;
            return {
              roundId: query.roundId,
              status,
              opensAt: options.opensAt ?? new Date("2026-10-01T00:00:00Z"),
              closesAt: options.closesAt ?? new Date("2026-12-01T00:00:00Z"),
              policyIds: options.roundPolicies ?? ["POL-010", "POL-011"],
            };
          },
        };
      }
      if (name === "policy_revisions") {
        return {
          async findOne(query: Record<string, unknown>) {
            if (options.revisionExists === false) return null;
            return { policyId: query.policyId, revisionId: query.revisionId };
          },
        };
      }
      if (name === "consultation_submissions") {
        return {
          async insertOne(doc: Record<string, unknown>) {
            submissions.push(doc);
            return { insertedId: doc._id };
          },
          async updateOne(filter: Record<string, unknown>, update: { $set: Record<string, unknown> }) {
            const target = submissions.find(
              (item) => item.submissionId === filter.submissionId && item.status === filter.status,
            );
            if (!target) return { modifiedCount: 0 };
            Object.assign(target, update.$set);
            return { modifiedCount: 1 };
          },
        };
      }
      if (name === "operational_audit") {
        return {
          async insertOne(doc: Record<string, unknown>) {
            audits.push(doc);
            return { insertedId: new ObjectId() };
          },
        };
      }
      throw new Error(`Unexpected collection: ${name}`);
    },
  };
  return db;
}

test("consultation submission rejects policies not included in the consultation round", async () => {
  const db = createFakeDb({ roundPolicies: ["POL-010", "POL-011"] });
  const input = validateSubmission({
    roundId: "first-priority-policy-round-2026",
    policyId: "POL-001",
    policyRevisionId: "reclaim-v1:POL-001",
    kind: "comment",
    body: "This policy is in Restore the Fair Go, not the initial 36-policy round.",
  });
  assert.ok(input);
  await assert.rejects(
    () => createSubmission(db as never, syntheticMember, input, new Date("2026-10-27T00:00:00Z")),
    /not included in the selected consultation round/,
  );
  assert.equal(db.submissions.length, 0);
});

test("consultation submission returns consistent submissionId matching _id and moderation lookup", async () => {
  const db = createFakeDb({ roundPolicies: ["POL-010"] });
  const input = validateSubmission({
    roundId: "first-priority-policy-round-2026",
    policyId: "POL-010",
    policyRevisionId: "demo-v1:POL-010",
    kind: "amendment",
    title: "Clarify transitional stamp duty credit period",
    body: "Specify the holding-period lookback window for crediting recent stamp duty payments against Land Value Tax.",
  });
  assert.ok(input);
  const returnedId = await createSubmission(db as never, syntheticMember, input, new Date("2026-10-27T00:00:00Z"));
  assert.equal(db.submissions.length, 1);
  const stored = db.submissions[0]!;
  assert.equal(stored.submissionId, returnedId);
  assert.equal((stored._id as ObjectId).toHexString(), returnedId);

  const reviewed = await reviewSubmission(
    db as never,
    syntheticModerator,
    returnedId,
    "accepted",
    "Adopted into settled revision v2 for ballot.",
  );
  assert.equal(reviewed, true);
  assert.equal(stored.status, "accepted");
  assert.equal(db.audits.length, 1);
});
