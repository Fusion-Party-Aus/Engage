/**
 * @deprecated Compatibility barrel for legacy callers.
 *
 * `store.ts` was split into focused domain modules (#115):
 * - `./proposal-helpers.ts`
 * - `./proposals-store.ts`
 * - `./comments-store.ts`
 * - `./contribution-feedback.ts`
 * - `./voting-store.ts`
 * - `./members-store.ts`
 *
 * Import directly from the relevant domain module in new code.
 */
export {
  PENDING_VOTE_PREFERENCES,
  VALID_KINDS,
  VALID_STAGES,
  VALID_STANCES,
  canReviewArchivedProposal,
  canViewProposal,
  getDefaultProvenanceLabel,
  getSubstantiveChanges,
  isGovernanceResolution,
  isPolicyProposal,
  isPolicyRegistryRecordForResolution,
  isProposalLocked,
  isValidStage,
  normalizeKind,
  normalizeProposalDoc,
  normalizeStage,
  parseOutcomes,
  slugify,
  validateStageTransition,
} from "./proposal-helpers.ts";

export {
  ProposalDeletionConflictError,
  ProposalSecondingError,
  deleteProposal,
  getProposalDetail,
  listProposalRevisions,
  listProposals,
  resolvePolicyChangeTarget,
  saveProposal,
  secondProposal,
  type ResolvedPolicyChangeTarget,
} from "./proposals-store.ts";

export {
  addComment,
  deleteComment,
  toggleUpvoteComment,
} from "./comments-store.ts";

export {
  canRespondToContribution,
  resolveContributionEvidenceMap,
  setCommentFeedback,
  type ResolvedContributionEvidence,
} from "./contribution-feedback.ts";

export {
  castVote,
  listOutstandingDecisions,
  listUserActivity,
  promotePendingVotePreferences,
  savePendingVotePreference,
} from "./voting-store.ts";

export { listMembers, saveMember } from "./members-store.ts";

import {
  deleteProposal,
  getProposalDetail,
  listProposals,
  saveProposal,
} from "./proposals-store.ts";

// Legacy aliases retained for existing callers.
export const listPolicies = listProposals;
export const getPolicyDetail = getProposalDetail;
export const savePolicy = saveProposal;
export const deletePolicy = deleteProposal;
