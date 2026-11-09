/** Explicit URL choices survive stage changes, including an explicit opt-out. */
export function discoveryFocus(params: URLSearchParams, canParticipate: boolean): string {
  const explicit = params.get('focus');
  if (explicit !== null) return explicit.trim();
  const stage = params.get('stage') ?? params.get('status');
  return canParticipate && (stage === 'decide' || stage === 'voting') ? 'needs-vote' : 'all';
}
