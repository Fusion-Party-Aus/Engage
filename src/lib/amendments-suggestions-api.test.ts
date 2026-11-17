import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { it } from "node:test";
import { createDevSessionCookie } from "./auth.ts";
import { getDatabase } from "./db.ts";
import { saveProposal } from "./proposals-store.ts";
import { POST as postAmendment } from "../pages/api/amendments.ts";
import { POST as resolveAmendment } from "../pages/api/admin/amendments/resolve.ts";
import { POST as applyAmendment } from "../pages/api/admin/amendments/apply.ts";
import type { SessionUser } from "./types.ts";

const env = { APP_MODE: "development" };
const locals = { runtime: { env } };
const adminCookie = createDevSessionCookie("administrator");
const memberCookie = createDevSessionCookie("member");

const admin: SessionUser = {
  memberId: "dev-admin-01",
  name: "Engage Admin",
  email: "admin@engage.local",
  role: "administrator",
  status: "verified",
  canParticipate: true,
  isStaff: true,
  isAdmin: true,
};

function request(path: string, cookie: string, body: unknown) {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function latestRevision(db: Awaited<ReturnType<typeof getDatabase>>, proposalId: string) {
  return (await db.collection("proposal_revisions").find({ proposalId }).sort({ createdAt: -1, _id: -1 }).limit(1).toArray())[0];
}

function appliedHash(base: Record<string, any>, overrides: Record<string, unknown>) {
  return createHash("sha256")
    .update(JSON.stringify({ ...base.snapshot, ...overrides }))
    .digest("hex");
}

it("stores block suggestions, reconstructs changes and rebases moved anchors on resolution", async () => {
  const db = await getDatabase(env);
  const proposal = await saveProposal(db, admin, {
    title: `Suggestion test ${crypto.randomUUID()}`,
    space: "Governance",
    summary: "A proposal with two commitments.",
    outcomes: ["Outcome one", "Outcome two"],
    details: "First rationale paragraph.\n\nSecond rationale paragraph.",
    stage: "deliberate",
  });
  const base = await latestRevision(db, proposal.proposalId);
  const response = await postAmendment({
    request: request("/api/amendments", memberCookie, {
      proposalId: proposal.proposalId,
      baseRevisionId: base.revisionId,
      suggestions: [
        { field: "outcomes", index: 0, original: "Outcome one", proposed: "A clearer first outcome" },
        { field: "details", index: 1, original: "Second rationale paragraph.", proposed: "Revised second paragraph." },
      ],
    }),
    locals,
  } as never);
  assert.equal(response.status, 201);
  const payload = (await response.json()) as { amendment: any };
  assert.equal(payload.amendment.suggestions.length, 2);
  assert.equal(payload.amendment.changes.outcomes[0], "A clearer first outcome");
  assert.equal(payload.amendment.changes.details, "First rationale paragraph.\n\nRevised second paragraph.");

  const stored = await db.collection("amendments").findOne({ amendmentId: payload.amendment.amendmentId });
  assert.equal(stored?.suggestions.length, 2);
  const revision = await db.collection("amendment_revisions").findOne({ amendmentId: payload.amendment.amendmentId });
  assert.equal(revision?.suggestions.length, 2);

  // Insert a new leading commitment. The quoted outcome moves from index 0 to 1.
  await saveProposal(db, admin, {
    proposalId: proposal.proposalId,
    outcomes: ["A new leading commitment", "Outcome one", "Outcome two"],
  });
  const latest = await latestRevision(db, proposal.proposalId);
  assert.notEqual(latest.revisionId, base.revisionId);

  const resolved = await resolveAmendment({
    request: request("/api/admin/amendments/resolve", adminCookie, {
      amendmentId: payload.amendment.amendmentId,
      outcome: "ready",
      reason: "Suggestion still applies after the new commitment.",
    }),
    locals,
  } as never);
  assert.equal(resolved.status, 200);
  const after = await db.collection("amendments").findOne({ amendmentId: payload.amendment.amendmentId });
  assert.equal(after?.status, "ready");
  assert.equal(after?.baseRevisionId, latest.revisionId);
  assert.deepEqual(after?.changes.outcomes, ["A new leading commitment", "A clearer first outcome", "Outcome two"]);
  assert.equal(after?.suggestions[0].index, 1);
});

it("rejects amendments whose reconstructed wording exceeds authoritative limits", async () => {
  const db = await getDatabase(env);
  const proposal = await saveProposal(db, admin, {
    title: `Length test ${crypto.randomUUID()}`,
    space: "Governance",
    summary: "A proposal used to test authoritative wording limits.",
    outcomes: ["An outcome"],
    details: "Rationale.",
    stage: "deliberate",
  });
  const base = await latestRevision(db, proposal.proposalId);
  const response = await postAmendment({
    request: request("/api/amendments", memberCookie, {
      proposalId: proposal.proposalId,
      baseRevisionId: base.revisionId,
      suggestions: [
        { field: "title", index: 0, original: proposal.title, proposed: "x".repeat(201) },
      ],
    }),
    locals,
  } as never);
  assert.equal(response.status, 400);
  assert.match(((await response.json()) as { error: string }).error, /4–200/);
});

it("refuses to apply a competing amendment after another amendment already applied", async () => {
  const db = await getDatabase(env);
  const proposal = await saveProposal(db, admin, {
    title: `Apply guard ${crypto.randomUUID()}`,
    space: "Governance",
    summary: "A proposal used to test the amendment precedence guard.",
    outcomes: ["First outcome", "Second outcome"],
    details: "Rationale.",
    stage: "deliberate",
  });
  const base = await latestRevision(db, proposal.proposalId);
  const appliedId = crypto.randomUUID();
  const acceptedId = crypto.randomUUID();
  const suggestion = {
    suggestionId: "sug-applied",
    field: "outcomes",
    index: 0,
    original: "First outcome",
    proposed: "Applied change",
    mode: "replace",
  };
  await db.collection("amendments").insertOne({
    amendmentId: appliedId,
    proposalId: proposal.proposalId,
    baseRevisionId: base.revisionId,
    currentRevisionId: crypto.randomUUID(),
    authorId: "dev-member-01",
    changes: { outcomes: ["Applied change", "Second outcome"] },
    fields: ["outcomes"],
    suggestions: [suggestion],
    status: "applied",
    conflicts: [],
    createdAt: new Date(),
  });
  await db.collection("amendments").insertOne({
    amendmentId: acceptedId,
    proposalId: proposal.proposalId,
    baseRevisionId: base.revisionId,
    currentRevisionId: crypto.randomUUID(),
    authorId: "dev-member-01",
    changes: { outcomes: ["Competing change", "Second outcome"] },
    fields: ["outcomes"],
    suggestions: [{ ...suggestion, suggestionId: "sug-accepted", proposed: "Competing change" }],
    status: "accepted",
    conflicts: [],
    createdAt: new Date(),
  });
  const response = await applyAmendment({
    request: request("/api/admin/amendments/apply", adminCookie, { amendmentId: acceptedId }),
    locals,
  } as never);
  assert.equal(response.status, 409);
  assert.match(((await response.json()) as { error: string }).error, /precedence/);
});

it("serialises concurrent apply requests and leaves one consistent applied revision", async () => {
  const db = await getDatabase(env);
  const proposal = await saveProposal(db, admin, {
    title: `Atomic apply ${crypto.randomUUID()}`,
    space: "Governance",
    summary: "A proposal used to test concurrent amendment application.",
    outcomes: ["First outcome", "Second outcome"],
    details: "Rationale.",
    stage: "deliberate",
  });
  const base = await latestRevision(db, proposal.proposalId);
  const amendmentId = crypto.randomUUID();
  await db.collection("amendments").insertOne({
    amendmentId,
    proposalId: proposal.proposalId,
    baseRevisionId: base.revisionId,
    currentRevisionId: crypto.randomUUID(),
    authorId: "dev-member-01",
    changes: { outcomes: ["Applied once", "Second outcome"] },
    fields: ["outcomes"],
    status: "accepted",
    conflicts: [],
    createdAt: new Date(),
  });
  const results = await Promise.all([
    applyAmendment({
      request: request("/api/admin/amendments/apply", adminCookie, { amendmentId }),
      locals,
    } as never),
    applyAmendment({
      request: request("/api/admin/amendments/apply", adminCookie, { amendmentId }),
      locals,
    } as never),
  ]);
  const statuses = results.map((result) => result.status);
  assert.equal(statuses.filter((status) => status === 200).length, 1);
  assert.ok(statuses.some((status) => status === 409 || status === 404));
  const stored = await db.collection("amendments").findOne({ amendmentId });
  assert.equal(stored?.status, "applied");
  const revisions = await db.collection("proposal_revisions").find({ proposalId: proposal.proposalId }).toArray();
  assert.equal(revisions.length, 2, "exactly one proposal revision is appended");
});

it("releases a claimed amendment when the proposal write fails", async () => {
  const db = await getDatabase(env);
  const proposal = await saveProposal(db, admin, {
    title: `Release claim ${crypto.randomUUID()}`,
    space: "Governance",
    summary: "A proposal used to test a failed amendment application.",
    outcomes: ["First outcome"],
    details: "Rationale.",
    stage: "deliberate",
  });
  const base = await latestRevision(db, proposal.proposalId);
  await db.collection("proposal_votes").insertOne({
    ballotId: `proposal:${proposal.proposalId}`,
    proposalId: proposal.proposalId,
    revisionId: base.revisionId,
    memberId: "dev-member-01",
    choice: "approve",
    updatedAt: new Date(),
  });
  const amendmentId = crypto.randomUUID();
  await db.collection("amendments").insertOne({
    amendmentId,
    proposalId: proposal.proposalId,
    baseRevisionId: base.revisionId,
    currentRevisionId: crypto.randomUUID(),
    authorId: "dev-member-01",
    changes: { outcomes: ["Blocked change"] },
    fields: ["outcomes"],
    status: "accepted",
    conflicts: [],
    createdAt: new Date(),
  });
  const response = await applyAmendment({
    request: request("/api/admin/amendments/apply", adminCookie, { amendmentId }),
    locals,
  } as never);
  assert.equal(response.status, 400);
  const stored = await db.collection("amendments").findOne({ amendmentId });
  assert.equal(stored?.status, "accepted");
  assert.equal(stored?.applyingToken, undefined);
});

it("recovers an incomplete applying state after the recovery window", async () => {
  const db = await getDatabase(env);
  const proposal = await saveProposal(db, admin, {
    title: `Recover apply ${crypto.randomUUID()}`,
    space: "Governance",
    summary: "A proposal used to test amendment application recovery.",
    outcomes: ["First outcome"],
    details: "Rationale.",
    stage: "deliberate",
  });
  const base = await latestRevision(db, proposal.proposalId);
  const amendmentId = crypto.randomUUID();
  await db.collection("amendments").insertOne({
    amendmentId,
    proposalId: proposal.proposalId,
    baseRevisionId: base.revisionId,
    currentRevisionId: crypto.randomUUID(),
    authorId: "dev-member-01",
    changes: { outcomes: ["Recovered change"] },
    fields: ["outcomes"],
    status: "applying",
    applyingToken: "recovery-token",
    applyingOperationId: "recovery-operation",
    applyingExpectedContentHash: appliedHash(base, { outcomes: ["Recovered change"] }),
    applyingStartedAt: new Date(Date.now() - 120_000),
    applyingLeaseExpiresAt: new Date(Date.now() - 60_000),
    applyingBy: "dev-admin-01",
    conflicts: [],
    createdAt: new Date(),
  });
  const response = await applyAmendment({
    request: request("/api/admin/amendments/apply", adminCookie, { amendmentId }),
    locals,
  } as never);
  assert.equal(response.status, 200);
  const stored = await db.collection("amendments").findOne({ amendmentId });
  assert.equal(stored?.status, "applied");
  assert.equal(stored?.applyingToken, undefined);
  assert.equal(
    await db.collection("proposal_revisions").countDocuments({ proposalId: proposal.proposalId }),
    2,
  );
});

it("finalises an application whose proposal write committed before the crash", async () => {
  const db = await getDatabase(env);
  const proposal = await saveProposal(db, admin, {
    title: `Committed recovery ${crypto.randomUUID()}`,
    space: "Governance",
    summary: "A proposal used to test a crash after the proposal write.",
    outcomes: ["First outcome"],
    details: "Rationale.",
    stage: "deliberate",
  });
  const base = await latestRevision(db, proposal.proposalId);
  await saveProposal(db, admin, {
    proposalId: proposal.proposalId,
    outcomes: ["Already written"],
  });
  const written = await latestRevision(db, proposal.proposalId);
  const expected = written.contentHash;
  const amendmentId = crypto.randomUUID();
  await db.collection("amendments").insertOne({
    amendmentId,
    proposalId: proposal.proposalId,
    baseRevisionId: base.revisionId,
    currentRevisionId: crypto.randomUUID(),
    authorId: "dev-member-01",
    changes: { outcomes: ["Already written"] },
    fields: ["outcomes"],
    status: "applying",
    applyingToken: "recovery-token",
    applyingOperationId: "recovery-operation",
    applyingExpectedContentHash: expected,
    applyingStartedAt: new Date(Date.now() - 120_000),
    applyingLeaseExpiresAt: new Date(Date.now() - 60_000),
    applyingBy: "dev-admin-01",
    conflicts: [],
    createdAt: new Date(),
  });
  const response = await applyAmendment({
    request: request("/api/admin/amendments/apply", adminCookie, { amendmentId }),
    locals,
  } as never);
  assert.equal(response.status, 200);
  assert.equal(
    await db.collection("proposal_revisions").countDocuments({ proposalId: proposal.proposalId }),
    2,
    "the recovery finalises without appending another revision",
  );
  assert.equal((await db.collection("amendments").findOne({ amendmentId }))?.status, "applied");
});

it("refuses to recover over an unrelated intervening revision", async () => {
  const db = await getDatabase(env);
  const proposal = await saveProposal(db, admin, {
    title: `Intervening recovery ${crypto.randomUUID()}`,
    space: "Governance",
    summary: "A proposal used to test recovery over an intervening edit.",
    outcomes: ["First outcome"],
    details: "Rationale.",
    stage: "deliberate",
  });
  const base = await latestRevision(db, proposal.proposalId);
  const amendmentId = crypto.randomUUID();
  await db.collection("amendments").insertOne({
    amendmentId,
    proposalId: proposal.proposalId,
    baseRevisionId: base.revisionId,
    currentRevisionId: crypto.randomUUID(),
    authorId: "dev-member-01",
    changes: { outcomes: ["Amendment wording"] },
    fields: ["outcomes"],
    status: "applying",
    applyingToken: "recovery-token",
    applyingOperationId: "recovery-operation",
    applyingExpectedContentHash: appliedHash(base, { outcomes: ["Amendment wording"] }),
    applyingStartedAt: new Date(Date.now() - 120_000),
    applyingLeaseExpiresAt: new Date(Date.now() - 60_000),
    applyingBy: "dev-admin-01",
    conflicts: [],
    createdAt: new Date(),
  });
  await saveProposal(db, admin, {
    proposalId: proposal.proposalId,
    outcomes: ["Intervening wording"],
  });
  const response = await applyAmendment({
    request: request("/api/admin/amendments/apply", adminCookie, { amendmentId }),
    locals,
  } as never);
  assert.equal(response.status, 409);
  const stored = await db.collection("amendments").findOne({ amendmentId });
  assert.equal(stored?.status, "applying");
  const latest = await latestRevision(db, proposal.proposalId);
  assert.deepEqual(latest.snapshot.outcomes, ["Intervening wording"]);
});

it("allows only one expired-lease recovery attempt to proceed", async () => {
  const db = await getDatabase(env);
  const proposal = await saveProposal(db, admin, {
    title: `Recovery race ${crypto.randomUUID()}`,
    space: "Governance",
    summary: "A proposal used to test concurrent amendment recovery.",
    outcomes: ["First outcome"],
    details: "Rationale.",
    stage: "deliberate",
  });
  const base = await latestRevision(db, proposal.proposalId);
  const amendmentId = crypto.randomUUID();
  await db.collection("amendments").insertOne({
    amendmentId,
    proposalId: proposal.proposalId,
    baseRevisionId: base.revisionId,
    currentRevisionId: crypto.randomUUID(),
    authorId: "dev-member-01",
    changes: { outcomes: ["Recovered once"] },
    fields: ["outcomes"],
    status: "applying",
    applyingToken: "recovery-token",
    applyingOperationId: "recovery-operation",
    applyingExpectedContentHash: appliedHash(base, { outcomes: ["Recovered once"] }),
    applyingStartedAt: new Date(Date.now() - 120_000),
    applyingLeaseExpiresAt: new Date(Date.now() - 60_000),
    applyingBy: "dev-admin-01",
    conflicts: [],
    createdAt: new Date(),
  });
  const results = await Promise.all([
    applyAmendment({
      request: request("/api/admin/amendments/apply", adminCookie, { amendmentId }),
      locals,
    } as never),
    applyAmendment({
      request: request("/api/admin/amendments/apply", adminCookie, { amendmentId }),
      locals,
    } as never),
  ]);
  const statuses = results.map((result) => result.status);
  assert.equal(statuses.filter((status) => status === 200).length, 1);
  assert.ok(statuses.some((status) => status === 409 || status === 404));
  assert.equal(
    await db.collection("proposal_revisions").countDocuments({ proposalId: proposal.proposalId }),
    2,
  );
});

it("refuses an anchor that disappeared and accepts explicit replacement wording", async () => {
  const db = await getDatabase(env);
  const proposal = await saveProposal(db, admin, {
    title: `Stale suggestion test ${crypto.randomUUID()}`,
    space: "Governance",
    summary: "A proposal used to test a missing anchor.",
    outcomes: ["Original commitment"],
    details: "Original rationale.",
    stage: "deliberate",
  });
  const base = await latestRevision(db, proposal.proposalId);
  const posted = await postAmendment({
    request: request("/api/amendments", memberCookie, {
      proposalId: proposal.proposalId,
      baseRevisionId: base.revisionId,
      suggestions: [
        { field: "outcomes", index: 0, original: "Original commitment", proposed: "Member replacement" },
      ],
    }),
    locals,
  } as never);
  const amendment = ((await posted.json()) as { amendment: any }).amendment;

  await saveProposal(db, admin, {
    proposalId: proposal.proposalId,
    outcomes: ["Completely different commitment"],
  });

  const refused = await resolveAmendment({
    request: request("/api/admin/amendments/resolve", adminCookie, {
      amendmentId: amendment.amendmentId,
      outcome: "ready",
      reason: "Try the original suggestion.",
    }),
    locals,
  } as never);
  assert.equal(refused.status, 409);

  const accepted = await resolveAmendment({
    request: request("/api/admin/amendments/resolve", adminCookie, {
      amendmentId: amendment.amendmentId,
      outcome: "ready",
      reason: "Officer rewrote the replacement for the latest wording.",
      changes: { outcomes: ["Officer replacement"] },
    }),
    locals,
  } as never);
  assert.equal(accepted.status, 200);
  const after = await db.collection("amendments").findOne({ amendmentId: amendment.amendmentId });
  assert.equal(after?.status, "ready");
  assert.deepEqual(after?.changes.outcomes, ["Officer replacement"]);
  assert.equal(after?.suggestions, undefined);
});
