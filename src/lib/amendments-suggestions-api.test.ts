import assert from "node:assert/strict";
import { it } from "node:test";
import { createDevSessionCookie } from "./auth.ts";
import { getDatabase } from "./db.ts";
import { saveProposal } from "./proposals-store.ts";
import { POST as postAmendment } from "../pages/api/amendments.ts";
import { POST as resolveAmendment } from "../pages/api/admin/amendments/resolve.ts";
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
  return (await db.collection("proposal_revisions").find({ proposalId }).sort({ createdAt: -1 }).limit(1).toArray())[0];
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
