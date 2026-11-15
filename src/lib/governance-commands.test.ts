import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { MongoClient, type Db } from "mongodb";
import {
  BALLOT_OUTCOME_RULE_BASIS,
  FORMAL_DECISIONS_COLLECTION,
  upsertMatterBallot,
} from "./ballots.ts";
import { PROPOSAL_VOTES, proposalBallotId } from "./vote-storage.ts";
import { GOVERNANCE_EVENTS_COLLECTION } from "./governance-relationships.ts";
import { ALL_NATIONAL_PERMISSIONS } from "./rbac.ts";
import { closeDatabase } from "./db.ts";
import { runGovernanceRoute } from "./route-policy.ts";
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
  const now = new Date();
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
      assert.equal(recorded.ruleBasis, BALLOT_OUTCOME_RULE_BASIS);
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
