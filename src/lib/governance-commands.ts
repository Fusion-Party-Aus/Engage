import type { Db } from "mongodb";
import { loadBallotCryptoConfigForRead } from "./ballot-crypto.ts";
import { bindBallotToRevision } from "./ballot-binding.ts";
import { recordFormalDecision } from "./ballots.ts";
import type { BallotAct } from "./ballot-authority.ts";
import type { PermissionKey } from "./rbac.ts";
import type { PlatformEnv } from "./types.ts";

/**
 * The typed governance command layer.
 *
 * A command declares one consequential governance act: who may perform it, how
 * its scope is resolved, what it requires to be true, what it changes and which
 * audit events it emits. Routes declare the permission once in
 * `src/lib/route-policy.ts` and call the command; they do not re-implement
 * authorisation or the domain rules.
 *
 * Commands are deliberately thin: they call the existing domain functions
 * (`bindBallotToRevision`, `recordFormalDecision`) and do not duplicate them.
 * Their value is one place for authorisation, scope resolution and
 * preconditions, not a second domain layer. Preconditions are documented on
 * each command for readers; the domain function the command calls enforces
 * them.
 *
 * Extraction is incremental (#53). Only the ballot lifecycle is migrated so
 * far; proposals and membership remain in their routes.
 */

export type GovernanceCommandId = "ballot.bind" | "ballot.record_result";

/** The member performing the act. Never inferred from client state. */
export interface GovernanceActor {
  memberId: string;
}

/**
 * The scope a command acts within. `branchScope` is the proposal's governance
 * authority branch (`undefined` for national matters); `ballot` carries the
 * branch facts the ballot-management rule needs.
 */
export interface GovernanceScope {
  branchScope?: string;
  ballot: {
    governanceAuthorityBranchId?: string;
    jurisdictionBranchId?: string;
  };
}

export type GovernanceResultType = "successful" | "unsuccessful" | "inconclusive";

export interface CommandOutcome {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export type InputParse<TInput> =
  | { ok: true; value: TInput }
  | { ok: false; status: 400; error: string };

export type SubjectLookup<TSubject> =
  | { ok: true; subject: TSubject }
  | { ok: false; status: number; error: string };

export interface GovernanceCommand<TInput, TSubject> {
  readonly id: GovernanceCommandId;
  /** One-line description used by documentation and tests. */
  readonly summary: string;
  /** The single permission this act requires. Declared per route too. */
  readonly requiredPermission: PermissionKey;
  /**
   * The ballot-authority act this command performs. The route policy resolves
   * it through `ballotActs`; commands without a ballot act fall back to the
   * branch-scope permission check.
   */
  readonly ballotAct?: BallotAct;
  /**
   * What must be true before the command executes. Documented for readers;
   * enforced by the domain function each command delegates to, not by this
   * layer.
   */
  readonly preconditions: readonly string[];
  /** What the command changes when it succeeds. */
  readonly effects: readonly string[];
  /** Audit events the command emits. */
  readonly events: readonly string[];
  /** Used only when a non-domain error without a message reaches the route. */
  readonly fallbackMessage: string;
  /** Response when the actor fails the resolved branch-scope check. */
  readonly scopeDeniedMessage: string;
  parse(body: Record<string, unknown>): InputParse<TInput>;
  loadSubject(db: Db, input: TInput): Promise<SubjectLookup<TSubject>>;
  resolveScope(subject: TSubject): GovernanceScope;
  execute(context: {
    db: Db;
    env: PlatformEnv;
    actor: GovernanceActor;
    input: TInput;
    subject: TSubject;
    scope: GovernanceScope;
  }): Promise<CommandOutcome>;
}

interface BindBallotInput {
  proposalId: string;
  revisionId: string;
  decisionEventId: string;
  reason: string;
}

interface BindBallotSubject {
  proposal: Record<string, any>;
}

const ballotBind: GovernanceCommand<BindBallotInput, BindBallotSubject> = {
  id: "ballot.bind",
  summary: "Bind a proposal ballot to one exact immutable wording revision.",
  requiredPermission: "ballots.bind",
  ballotAct: "bindMatterBallot",
  preconditions: [
    "The proposal exists in the Decide stage.",
    "The selected revision belongs to that proposal.",
    "Recorded votes and any existing binding do not name another revision.",
  ],
  effects: [
    "Stores the ballot revision and binding actor on the proposal.",
    "Attaches unbound votes to the reviewed revision.",
    "Writes a ballot binding event and opens the matching matter ballot.",
  ],
  events: ["ballot.bound"],
  fallbackMessage: "Could not bind the ballot to a reviewed revision.",
  scopeDeniedMessage: "You are not authorised to review this ballot.",
  parse(body) {
    const proposalId =
      typeof body.proposalId === "string" ? body.proposalId.trim() : "";
    const revisionId =
      typeof body.revisionId === "string" ? body.revisionId.trim() : "";
    const decisionEventId =
      typeof body.decisionEventId === "string"
        ? body.decisionEventId.trim().slice(0, 200)
        : "";
    const reason =
      typeof body.reason === "string" ? body.reason.trim().slice(0, 1000) : "";
    if (!proposalId || !revisionId || !decisionEventId || !reason)
      return {
        ok: false,
        status: 400,
        error:
          "Proposal, exact revision, decision event reference and review reason are required.",
      };
    return { ok: true, value: { proposalId, revisionId, decisionEventId, reason } };
  },
  async loadSubject(db, input) {
    const proposal = await db
      .collection("proposals")
      .findOne({ proposalId: input.proposalId, stage: "decide" });
    if (!proposal)
      return { ok: false, status: 404, error: "Open proposal ballot not found." };
    return { ok: true, subject: { proposal } };
  },
  resolveScope(subject) {
    const { proposal } = subject;
    return {
      branchScope:
        typeof proposal.governanceAuthorityBranchId === "string"
          ? proposal.governanceAuthorityBranchId
          : undefined,
      ballot: {
        governanceAuthorityBranchId: proposal.governanceAuthorityBranchId,
        jurisdictionBranchId: proposal.jurisdictionBranchId,
      },
    };
  },
  async execute({ db, actor, input }) {
    const { event, idempotent } = await bindBallotToRevision(db, {
      proposalId: input.proposalId,
      revisionId: input.revisionId,
      decisionEventId: input.decisionEventId,
      reason: input.reason,
      actorId: actor.memberId,
    });
    return { status: idempotent ? 200 : 201, body: { event } };
  },
};

interface RecordResultInput {
  proposalId: string;
  result: GovernanceResultType;
  decisionEventId: string;
  overrideReason: string;
}

interface RecordResultSubject {
  proposal: Record<string, any>;
  revisionId: string;
}

const ballotRecordResult: GovernanceCommand<
  RecordResultInput,
  RecordResultSubject
> = {
  id: "ballot.record_result",
  summary: "Record the certified outcome of a revision-bound formal ballot.",
  requiredPermission: "ballots.record_result",
  ballotAct: "recordMatterResult",
  preconditions: [
    "The proposal is in the Decide stage with a bound ballot revision.",
    "The ballot is closed.",
    "Any recorded result is immutable; an identical retry returns the original.",
    "A result that contradicts the computed outcome carries a written reason.",
  ],
  effects: [
    "Inserts the immutable formal decision for the bound revision and tally.",
    "Certifies the ballot.",
    "Writes the decision governance event.",
  ],
  events: ["decision.recorded"],
  fallbackMessage: "Could not record ballot result.",
  scopeDeniedMessage:
    "You are not authorised to record an outcome for this ballot. Branch ballots require explicitly matching authority and jurisdiction.",
  parse(body) {
    const proposalId = String(body.proposalId ?? "");
    const result = String(body.result ?? "");
    const decisionEventId = String(body.decisionEventId ?? "");
    const overrideReason =
      typeof body.overrideReason === "string" ? body.overrideReason.trim() : "";
    if (
      !proposalId ||
      !decisionEventId ||
      !["successful", "unsuccessful", "inconclusive"].includes(result)
    )
      return {
        ok: false,
        status: 400,
        error: "proposalId, decisionEventId and a valid result are required.",
      };
    return {
      ok: true,
      value: {
        proposalId,
        result: result as GovernanceResultType,
        decisionEventId,
        overrideReason,
      },
    };
  },
  async loadSubject(db, input) {
    const proposal = await db
      .collection("proposals")
      .findOne({ proposalId: input.proposalId });
    if (!proposal || proposal.stage !== "decide" || !proposal.ballotRevisionId)
      return {
        ok: false,
        status: 409,
        error: "Proposal must have an active, revision-bound ballot.",
      };
    return {
      ok: true,
      subject: { proposal, revisionId: String(proposal.ballotRevisionId) },
    };
  },
  resolveScope(subject) {
    const { proposal } = subject;
    return {
      branchScope:
        typeof proposal.governanceAuthorityBranchId === "string"
          ? proposal.governanceAuthorityBranchId
          : undefined,
      ballot: {
        governanceAuthorityBranchId: proposal.governanceAuthorityBranchId,
        jurisdictionBranchId: proposal.jurisdictionBranchId,
      },
    };
  },
  async execute({ db, env, actor, input, subject, scope }) {
    const record = await recordFormalDecision(db, {
      matterId: input.proposalId,
      revisionId: subject.revisionId,
      result: input.result,
      decisionEventId: input.decisionEventId,
      overrideReason: input.overrideReason,
      cryptoConfig: loadBallotCryptoConfigForRead(env),
      authorityBranchId: scope.branchScope,
      recordedBy: actor.memberId,
    });
    const { _id: _resultId, ...publicResult } =
      record as unknown as Record<string, unknown>;
    return {
      status: 201,
      body: { result: publicResult },
      headers: { "cache-control": "private, no-store" },
    };
  },
};

export const GOVERNANCE_COMMANDS: Record<
  GovernanceCommandId,
  GovernanceCommand<any, any>
> = {
  "ballot.bind": ballotBind,
  "ballot.record_result": ballotRecordResult,
};

export function governanceCommand(
  id: GovernanceCommandId,
): GovernanceCommand<any, any> {
  return GOVERNANCE_COMMANDS[id];
}
