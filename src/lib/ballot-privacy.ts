import { canViewIdentifiableBallots } from "./auth.ts";
import type { SessionUser, VoteRecord } from "./types.ts";

/**
 * Return the ballot records a viewer may see.
 *
 * Only the explicitly authorised role (national administrators) receives
 * identifiable records. Every other viewer, including moderators and
 * anonymous visitors, receives only their own ballot view. Ordinary members
 * never receive another member's choice, reason, member ID or display name.
 */
export function ballotRecordsForViewer(
  votes: VoteRecord[],
  user: SessionUser | null | undefined,
): Array<Omit<VoteRecord, "memberId" | "authorName">> {
  if (canViewIdentifiableBallots(user)) return votes;
  if (!user) return [];
  return votes
    .filter((vote) => vote.memberId === user.memberId)
    .map(({ memberId: _memberId, authorName: _authorName, ...vote }) => vote);
}
