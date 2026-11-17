import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { MongoClient, type Db } from "mongodb";
import {
  LEGACY_BALLOT_OUTCOME_RULE_BASIS,
  FORMAL_DECISIONS_COLLECTION,
  upsertMatterBallot,
} from "./ballots.ts";
import { PROPOSAL_VOTES, proposalBallotId } from "./vote-storage.ts";
import { GOVERNANCE_EVENTS_COLLECTION } from "./governance-relationships.ts";
import { ALL_NATIONAL_PERMISSIONS } from "./rbac.ts";
import { closeDatabase } from "./db.ts";
import { runGovernanceRoute } from "./route-policy.ts";
import {
  GOVERNANCE_COMMANDS,
  type GovernanceCommandId,
} from "./governance-commands.ts";
import type { PlatformEnv, SessionUser } from "./types.ts";
import { POST as bindRoute } from "../pages/api/admin/ballots/bind.ts";
import { POST as recordResultRoute } from "../pages/api/admin/ballots/result.ts";

// These cases prove the ballot commands keep the domain behaviour they wrap:
// same persistence, same idempotency, same refusals and the same HTTP mapping.
// They run against a real MongoDB replica set because `recordFormalDecision`
// writes in a transaction. Set VOTING_TEST_MONGODB_URI to run them.
const mongoUri = process.env.VOTING_TEST_MONGODB_URI;

const revisionIdFor = (proposalId: string) => `rev-${proposalId.toLowerCase()}`;

const makeUser = (overrides: Partial<SessionUser> = {}): SessionUser => ({
  memberId: "admin-1",
  name: "Admin One",
  email: "admin@example.test",
  role: "administrator",
  roles: ["member", "administrator"],
  status: "verified",
  canParticipate: true,
  isStaff: true,
  isAdmin: true,
  isBranchAdmin: false,
  branchAdminIds: [],
  permissions: {
    national: [...ALL_NATIONAL_PERMISSIONS],
    branches: {},
    grants: [],
  },
  ...overrides,
});

async function seedProposal(
  db: Db,
  proposalId: string,
  options: {
    branchId?: string;
    bound?: boolean;
    closed?: boolean;
  } = {},
): Promise<void> {
  const now = new Date();
  const branchFacts = options.branchId
    ? {
        governanceAuthorityBranchId: options.branchId,
        jurisdictionBranchId: options.branchId,
      }
    : {};
  await db.collection("proposals").insertOne({
    proposalId,
    slug: proposalId.toLowerCase(),
    title: `Command layer ${proposalId}`,
    summary: "Command layer fixture.",
    details: "",
    stage: "decide",
    ...branchFacts,
    ...(options.bound ? { ballotRevisionId: revisionIdFor(proposalId) } : {}),
    createdAt: now,
    updatedAt: now,
  });
  await db.collection("proposal_revisions").insertOne({
    proposalId,
    revisionId: revisionIdFor(proposalId),
    parentRevisionId: null,
    createdAt: now,
    snapshot: { title: `Command layer ${proposalId}` },
    contentHash: `hash-${proposalId}`,
  });
  if (options.bound) {
    await upsertMatterBallot(db, {
      matterId: proposalId,
      revisionId: revisionIdFor(proposalId),
      status: "open",
    });
    if (options.closed) await closeBallot(db, proposalId);
  }
}

async function closeBallot(db: Db, proposalId: string): Promise<void> {
  // This fixture covers the certification command before the two-tier quorum
  // rule took effect. Quorum has its own MongoDB coverage in quorum-mongo.test.
  const now = new Date("2026-11-01T00:00:00.000Z");
  await db
    .collection("proposals")
    .updateOne({ proposalId }, { $set: { ballotClosedAt: now } });
  await db
    .collection("ballots")
    .updateOne(
      { ballotId: proposalBallotId(proposalId) },
      { $set: { status: "closed", updatedAt: now } },
    );
}

async function seedVotes(
  db: Db,
  proposalId: string,
  choices: ("approve" | "reject" | "abstain")[],
): Promise<void> {
  const ballotId = proposalBallotId(proposalId);
  await db.collection(PROPOSAL_VOTES).insertMany(
    choices.map((choice, index) => ({
      ballotId,
      proposalId,
      memberId: `voter-${proposalId}-${index}`,
      choice,
      revisionId: revisionIdFor(proposalId),
      updatedAt: new Date(),
    })),
  );
}

describe(
  "governance ballot routes and commands (real MongoDB replica set)",
  { skip: !mongoUri },
  () => {
    let client: MongoClient;
    let db: Db;
    let env: PlatformEnv;

    before(async () => {
      client = await new MongoClient(mongoUri!).connect();
      db = client.db(
        `engage_command_layer_test_${crypto.randomUUID().replaceAll("-", "")}`,
      );
      env = {
        APP_MODE: "test",
        MONGODB_URI: mongoUri,
        MONGODB_DB_NAME: db.databaseName,
      };
    });

    after(async () => {
      // The routes resolve the application client for `env`.
      await closeDatabase();
      await db?.dropDatabase();
      await client?.close();
    });

    const callRoute = (
      handler: typeof bindRoute,
      path: string,
      body: Record<string, unknown>,
      cookie = "engage_dev_user=administrator",
    ) =>
      handler({
        request: new Request(`http://localhost${path}`, {
          method: "POST",
          headers: { Cookie: cookie, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
        locals: { runtime: { env } },
      } as never);

    it("bind route records through bindBallotToRevision and is idempotent", async () => {
      const proposalId = "PROP-BIND-COMMAND";
      await seedProposal(db, proposalId, { branchId: "branch-vic" });
      const body = {
        proposalId,
        revisionId: revisionIdFor(proposalId),
        decisionEventId: "BIND-COMMAND-1",
        reason: "Compared the saved wording with the recorded ballot evidence.",
      };

      let response = await callRoute(
        bindRoute,
        "/api/admin/ballots/bind",
        body,
      );
      assert.equal(response.status, 201);
      const event = (
        (await response.json()) as {
          event: { eventId: string; actorId: string };
        }
      ).event;
      assert.equal(event.actorId, "dev-admin-01");
      assert.equal(
        (await db.collection("proposals").findOne({ proposalId }))
          ?.ballotRevisionId,
        revisionIdFor(proposalId),
      );
      assert.equal(
        await db
          .collection("ballot_binding_events")
          .countDocuments({ proposalId, revisionId: revisionIdFor(proposalId) }),
        1,
      );

      response = await callRoute(bindRoute, "/api/admin/ballots/bind", body);
      assert.equal(response.status, 200, "an identical retry is idempotent");
      assert.equal(
        ((await response.json()) as { event: { eventId: string } }).event
          .eventId,
        event.eventId,
      );
      assert.equal(
        await db
          .collection("ballot_binding_events")
          .countDocuments({ proposalId }),
        1,
      );
    });

    it("bind route keeps the pre-existing 400 for a conflicting ballot revision", async () => {
      const proposalId = "PROP-BIND-CONFLICT";
      await seedProposal(db, proposalId);
      // A ballot row already bound to another revision makes the domain's
      // upsertMatterBallot throw BallotDomainError(409). The old bind route
      // caught only BallotBindingError, so this surfaced as the generic 400.
      await db.collection("ballots").insertOne({
        ballotId: proposalBallotId(proposalId),
        matterId: proposalId,
        revisionId: "rev-already-bound",
      });
      const body = {
        proposalId,
        revisionId: revisionIdFor(proposalId),
        decisionEventId: "BIND-CONFLICT-1",
        reason: "Conflicting ballot revision fixture.",
      };

      let response = await callRoute(
        bindRoute,
        "/api/admin/ballots/bind",
        body,
      );
      assert.equal(response.status, 400, "bind must not be upgraded to 409");
      assert.equal(
        ((await response.json()) as { error: string }).error,
        "Ballot is already bound to a different immutable wording revision.",
      );
      assert.equal(
        await db
          .collection("ballot_binding_events")
          .countDocuments({ proposalId }),
        1,
      );

      response = await callRoute(bindRoute, "/api/admin/ballots/bind", body);
      assert.equal(response.status, 200, "an identical retry is idempotent");
      assert.equal(
        await db
          .collection("ballot_binding_events")
          .countDocuments({ proposalId }),
        1,
        "no second binding event is written",
      );
    });

    it("bind command refuses a branch administrator outside the ballot authority", async () => {
      const proposalId = "PROP-BIND-MISMATCH";
      await seedProposal(db, proposalId, { branchId: "branch-vic" });
      const otherBranchAdmin = makeUser({
        memberId: "branch-officer-nsw",
        role: "member",
        roles: ["member"],
        isStaff: false,
        isAdmin: false,
        isBranchAdmin: true,
        branchAdminIds: ["branch-nsw"],
        permissions: {
          national: [],
          branches: { "branch-nsw": ["ballots.bind"] },
          grants: [],
        },
      });
      const outcome = await runGovernanceRoute(
        "POST /api/admin/ballots/bind",
        { env, user: otherBranchAdmin, getDb: async () => db },
        {
          proposalId,
          revisionId: revisionIdFor(proposalId),
          decisionEventId: "BIND-MISMATCH-1",
          reason: "Attempted review from the wrong branch.",
        },
      );
      assert.equal(outcome.status, 403);
      assert.equal(
        (outcome.body as { error: string }).error,
        "You are not authorised to review this ballot.",
      );
      assert.equal(
        await db
          .collection("ballot_binding_events")
          .countDocuments({ proposalId }),
        0,
      );
      assert.equal(
        (await db.collection("proposals").findOne({ proposalId }))
          ?.ballotRevisionId,
        undefined,
      );
    });

    it("record_result refuses an open ballot, then records and certifies once", async () => {
      const proposalId = "PROP-RESULT-COMMAND";
      await seedProposal(db, proposalId, { bound: true });
      await seedVotes(db, proposalId, ["approve", "approve", "reject"]);
      const body = {
        proposalId,
        result: "successful",
        decisionEventId: "RESULT-COMMAND-1",
      };

      let response = await callRoute(
        recordResultRoute,
        "/api/admin/ballots/result",
        body,
      );
      assert.equal(response.status, 409, "an open ballot cannot be certified");
      assert.match(
        String(((await response.json()) as { error: string }).error),
        /can still accept votes|recorded close/,
      );
      assert.equal(
        await db
          .collection(FORMAL_DECISIONS_COLLECTION)
          .countDocuments({ proposalId }),
        0,
      );

      await closeBallot(db, proposalId);

      response = await callRoute(
        recordResultRoute,
        "/api/admin/ballots/result",
        body,
      );
      assert.equal(response.status, 201);
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      const recorded = (
        (await response.json()) as { result: Record<string, unknown> }
      ).result;
      assert.equal(recorded.result, "successful");
      assert.equal(recorded.computedResult, "successful");
      assert.equal(recorded.ruleBasis, LEGACY_BALLOT_OUTCOME_RULE_BASIS);
      assert.equal(recorded.recordedBy, "dev-admin-01");
      assert.ok(!("_id" in recorded));
      assert.deepEqual(recorded.tally, {
        approve: 2,
        abstain: 0,
        reject: 1,
        total: 3,
      });
      assert.equal(
        (await db.collection("ballots").findOne({
          ballotId: proposalBallotId(proposalId),
        }))?.status,
        "certified",
      );
      assert.equal(
        await db
          .collection(FORMAL_DECISIONS_COLLECTION)
          .countDocuments({ proposalId }),
        1,
      );
      assert.equal(
        await db
          .collection(GOVERNANCE_EVENTS_COLLECTION)
          .countDocuments({
            matterId: proposalId,
            eventType: "decision.recorded",
          }),
        1,
      );

      response = await callRoute(
        recordResultRoute,
        "/api/admin/ballots/result",
        body,
      );
      assert.equal(response.status, 201, "an identical retry is idempotent");
      assert.equal(
        ((await response.json()) as { result: { decisionEventId: string } })
          .result.decisionEventId,
        "RESULT-COMMAND-1",
      );
      assert.equal(
        await db
          .collection(FORMAL_DECISIONS_COLLECTION)
          .countDocuments({ proposalId }),
        1,
      );

      response = await callRoute(
        recordResultRoute,
        "/api/admin/ballots/result",
        { ...body, decisionEventId: "RESULT-COMMAND-2" },
      );
      assert.equal(response.status, 409);
      assert.match(
        String(((await response.json()) as { error: string }).error),
        /already recorded and cannot be replaced/,
      );
    });

    it("record_result allows a national permission holder and attributes the act", async () => {
      const proposalId = "PROP-RESULT-HOLDER";
      await seedProposal(db, proposalId, { bound: true, closed: true });
      await seedVotes(db, proposalId, ["approve"]);
      const holder = makeUser({
        memberId: "returning-officer",
        role: "member",
        roles: ["member"],
        isStaff: false,
        isAdmin: false,
        isBranchAdmin: false,
        permissions: {
          national: ["ballots.record_result"],
          branches: {},
          grants: [],
        },
      });
      const outcome = await runGovernanceRoute(
        "POST /api/admin/ballots/result",
        { env, user: holder, getDb: async () => db },
        {
          proposalId,
          result: "successful",
          decisionEventId: "RESULT-HOLDER-1",
        },
      );
      assert.equal(outcome.status, 201);
      assert.equal(
        (outcome.body as { result: { recordedBy: string } }).result.recordedBy,
        "returning-officer",
      );
      assert.equal(
        (outcome.headers ?? {})["cache-control"],
        "private, no-store",
      );
    });

    it("result route denies a branch administrator outside the ballot authority without writing", async () => {
      const proposalId = "PROP-RESULT-SCOPE-DENIED";
      await seedProposal(db, proposalId, {
        branchId: "branch-vic",
        bound: true,
        closed: true,
      });
      await seedVotes(db, proposalId, ["approve"]);
      // The development member becomes a branch administrator of another branch
      // so the route passes the coarse role gate and fails the scope gate.
      await db.collection("branch_memberships").insertOne({
        memberId: "dev-member-01",
        branchId: "branch-nsw",
        branchRole: "administrator",
        status: "active",
        assignedBy: "fixture",
        assignedAt: new Date(),
      });
      const response = await callRoute(
        recordResultRoute,
        "/api/admin/ballots/result",
        {
          proposalId,
          result: "successful",
          decisionEventId: "RESULT-SCOPE-DENIED-1",
        },
        "engage_dev_user=member",
      );
      assert.equal(response.status, 403);
      assert.match(
        String(((await response.json()) as { error: string }).error),
        /not authorised to record an outcome/,
      );
      assert.equal(
        await db
          .collection(FORMAL_DECISIONS_COLLECTION)
          .countDocuments({ proposalId }),
        0,
      );
      assert.equal(
        (await db.collection("ballots").findOne({
          ballotId: proposalBallotId(proposalId),
        }))?.status,
        "closed",
        "the denied request must not certify the ballot",
      );
      assert.equal(
        await db
          .collection(GOVERNANCE_EVENTS_COLLECTION)
          .countDocuments({
            matterId: proposalId,
            eventType: "decision.recorded",
          }),
        0,
      );
    });

    it("writes every audit event each command declares", async () => {
      const bindProposalId = "PROP-EVENTS-BIND";
      await seedProposal(db, bindProposalId);
      let response = await callRoute(
        bindRoute,
        "/api/admin/ballots/bind",
        {
          proposalId: bindProposalId,
          revisionId: revisionIdFor(bindProposalId),
          decisionEventId: "EVENTS-BIND-1",
          reason: "Audit event declaration fixture.",
        },
      );
      assert.equal(response.status, 201);

      const resultProposalId = "PROP-EVENTS-RESULT";
      await seedProposal(db, resultProposalId, {
        bound: true,
        closed: true,
      });
      await seedVotes(db, resultProposalId, ["approve"]);
      response = await callRoute(
        recordResultRoute,
        "/api/admin/ballots/result",
        {
          proposalId: resultProposalId,
          result: "successful",
          decisionEventId: "EVENTS-RESULT-1",
        },
      );
      assert.equal(response.status, 201);

      const writtenEvents = async (matterId: string) =>
        new Set(
          (
            await db
              .collection(GOVERNANCE_EVENTS_COLLECTION)
              .find({ matterId })
              .toArray()
          ).map((event) => String(event.eventType)),
        );
      const fixtures: Record<GovernanceCommandId, string> = {
        "ballot.bind": bindProposalId,
        "ballot.record_result": resultProposalId,
      };
      for (const [commandId, matterId] of Object.entries(fixtures) as Array<
        [GovernanceCommandId, string]
      >) {
        const declared = GOVERNANCE_COMMANDS[commandId].events;
        assert.ok(declared.length > 0, `${commandId} must declare its events`);
        const written = await writtenEvents(matterId);
        for (const eventType of declared)
          assert.ok(
            written.has(eventType),
            `${commandId} declares '${eventType}' but wrote ${[...written].join(", ")}`,
          );
      }
    });

    it("denies an ordinary moderator before any database work", async () => {
      let databaseReads = 0;
      const moderator = makeUser({
        memberId: "moderator-1",
        role: "moderator",
        roles: ["member", "moderator"],
        isStaff: true,
        isAdmin: false,
        permissions: {
          national: ["proposals.edit", "comments.moderate", "reports.export"],
          branches: {},
          grants: [],
        },
      });
      const getDb = async () => {
        databaseReads += 1;
        return db;
      };
      for (const route of [
        "POST /api/admin/ballots/bind",
        "POST /api/admin/ballots/result",
      ] as const) {
        const outcome = await runGovernanceRoute(
          route,
          { env, user: moderator, getDb },
          {},
        );
        assert.equal(outcome.status, 403);
        assert.equal(
          (outcome.body as { error: string }).error,
          "Administrator access required.",
        );
      }
      assert.equal(databaseReads, 0);
    });
  },
);
