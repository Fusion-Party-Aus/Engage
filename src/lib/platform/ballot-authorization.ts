/** Evidence references are recorded by an authorised administrator, never inferred from login configuration. */
export const ballotSafeguards = ['constitutionalEligibility', 'manualVerification', 'confidentiality', 'accessControls', 'backupRecovery', 'governanceApproval'] as const;
export function validBallotEvidence(value: unknown): value is Record<typeof ballotSafeguards[number], string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const evidence = value as Record<string, unknown>;
  return ballotSafeguards.every((key) => typeof evidence[key] === 'string' && evidence[key].trim().length >= 10 && evidence[key].length <= 2000);
}
export function bindingBallotAuthorised(ballot: { syntheticFixture?: boolean; bindingBallotsEnabled?: boolean; authorization?: { approvedBy?: string; approvedAt?: Date; evidence?: unknown } }): boolean {
  return !ballot.syntheticFixture && ballot.bindingBallotsEnabled === true && Boolean(ballot.authorization?.approvedBy && ballot.authorization.approvedAt instanceof Date && validBallotEvidence(ballot.authorization.evidence));
}
