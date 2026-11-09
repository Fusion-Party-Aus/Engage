/** URL selection wins over a restored Voting preference, then stage defaults. */
export function discoveryFocus(params: URLSearchParams, canParticipate: boolean, restored?: string): string {
  const stage = params.get('stage') ?? params.get('status') ?? 'all';
  const voting = stage === 'decide' || stage === 'voting';
  const explicit = params.has('needsVote') ? 'needs-vote' : params.get('focus');
  const focus = explicit ?? (voting ? restored : undefined) ?? (voting && canParticipate ? 'needs-vote' : 'all');
  if (focus === 'needs-vote' && (!canParticipate || !voting)) return 'all';
  return ['all', 'needs-vote', 'discussion', 'recent'].includes(focus) ? focus : 'all';
}
