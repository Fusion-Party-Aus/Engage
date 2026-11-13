import type { Db } from "mongodb";
import type { ActivityTimelineEvent } from "./activity-timeline.ts";
import { canViewProposal } from "./store.ts";
import type { ProposalRecord, SessionUser } from "./types.ts";
import { loadBallotCryptoConfig } from "./ballot-crypto.ts";
import { findMemberVotes, proposalBallotId } from "./vote-storage.ts";

async function findAllMemberVotes(db: Db, memberId: string) {
  const cryptoConfig = loadBallotCryptoConfig(process.env);
  if (!cryptoConfig) {
    return findMemberVotes(db, memberId, [], null);
  }
  const [proposals, amendments] = await Promise.all([
    db.collection("proposals").find({}).project({ proposalId: 1 }).toArray(),
    db.collection("amendments").find({}).project({ amendmentId: 1 }).toArray(),
  ]);
  const ballotIds = [
    ...proposals.map((p) => proposalBallotId(String(p.proposalId))),
    ...amendments.map((a) => `amendment:${String(a.amendmentId)}`),
  ];
  return findMemberVotes(db, memberId, ballotIds, cryptoConfig);
}

const asDate = (value: unknown): Date | null => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
};

const voteLabel = (choice: string) =>
  choice === "approve"
    ? "Approved"
    : choice === "abstain"
      ? "Abstained"
      : "Rejected";

const stageLabel = (stage: string) =>
  stage === "decide"
    ? "Open vote"
    : stage === "deliberate"
      ? "In discussion"
      : stage === "implement"
        ? "Implement"
        : stage === "archived"
          ? "Archived"
          : "New idea";

const resultLabel = (result: string) =>
  result === "successful"
    ? "Successful"
    : result === "unsuccessful"
      ? "Unsuccessful"
      : result === "inconclusive"
        ? "Inconclusive"
        : result === "endorsed"
          ? "Endorsed"
          : result === "not-endorsed"
            ? "Not endorsed"
            : result.replaceAll("-", " ");

const endorsementLabel = (count: number) =>
  `${count} endorsement${count === 1 ? "" : "s"}`;

/**
 * Build the member-facing activity stream from participation records and
 * governance outcomes. Administrative audit collections are deliberately not
 * included; only events that concern the member's own contributions.
 */
export async function listMemberActivityStream(
  db: Db,
  memberId: string,
): Promise<ActivityTimelineEvent[]> {
  const [votes, ownComments, endorsedComments, amendments, authoredProposals] =
    await Promise.all([
      findAllMemberVotes(db, memberId),
      db.collection("comments").find({ memberId }).toArray(),
      db
        .collection("comments")
        .find({ "upvoteEvents.memberId": memberId, memberId: { $ne: memberId } })
        .toArray(),
      db.collection("amendments").find({ authorId: memberId }).toArray(),
      db.collection("proposals").find({ authorId: memberId }).toArray(),
    ]);

  const proposalIds = new Set<string>();
  for (const vote of votes) proposalIds.add(String(vote.proposalId));
  for (const comment of ownComments) proposalIds.add(String(comment.proposalId));
  for (const comment of endorsedComments)
    proposalIds.add(String(comment.proposalId));
  for (const amendment of amendments)
    proposalIds.add(String(amendment.proposalId));
  for (const proposal of authoredProposals)
    proposalIds.add(String(proposal.proposalId));

  const proposalDocs = proposalIds.size
    ? await db
        .collection("proposals")
        .find({ proposalId: { $in: [...proposalIds] } })
        .toArray()
    : [];
  const proposalMap = new Map(
    proposalDocs.map((proposal) => [String(proposal.proposalId), proposal]),
  );
  const titleFor = (proposalId: unknown) =>
    String(proposalMap.get(String(proposalId))?.title ?? proposalId);
  const hrefFor = (proposalId: unknown) => {
    const proposal = proposalMap.get(String(proposalId));
    return proposal?.slug ? `/proposals/${proposal.slug}/` : undefined;
  };

  const events: ActivityTimelineEvent[] = [];

  for (const vote of votes) {
    const date = asDate(vote.updatedAt);
    if (!date) continue;
    const isAmendment = Boolean(vote.amendmentId);
    events.push({
      id: `vote-${vote.ballotId ?? vote.proposalId}-${date.toISOString()}`,
      date,
      actor: "You",
      action: isAmendment ? "voted on an amendment to" : "voted on",
      target: titleFor(vote.proposalId),
      href: hrefFor(vote.proposalId),
      kind: "vote",
      badge: voteLabel(String(vote.choice)),
      summary: vote.reason ? `Reason: ${vote.reason}` : undefined,
    });
  }

  for (const proposal of authoredProposals) {
    const date = asDate(proposal.createdAt);
    if (!date) continue;
    events.push({
      id: `proposal-${proposal.proposalId}`,
      date,
      actor: "You",
      action: "submitted",
      target: String(proposal.title),
      href: hrefFor(proposal.proposalId),
      kind: "proposal",
      badge: stageLabel(String(proposal.stage)),
      summary: String(proposal.space ?? ""),
    });
  }

  for (const comment of ownComments) {
    const date = asDate(comment.createdAt);
    if (!date) continue;
    const endorsements = Array.isArray(comment.upvotes)
      ? comment.upvotes.length
      : 0;
    events.push({
      id: `comment-${comment.commentId}`,
      date,
      actor: "You",
      action: "contributed to",
      target: titleFor(comment.proposalId),
      href: hrefFor(comment.proposalId)
        ? `${hrefFor(comment.proposalId)}#deliberation`
        : undefined,
      kind: "contribution",
      badge: `Stance: ${comment.stance}`,
      summary: String(comment.body ?? ""),
      details:
        endorsements > 0
          ? [{ label: endorsementLabel(endorsements) }]
          : undefined,
    });

    const history = Array.isArray(comment.feedbackHistory)
      ? comment.feedbackHistory
      : comment.feedback
        ? [{ action: comment.feedback.status, ...comment.feedback }]
        : [];
    for (const entry of history) {
      if (entry.action === "cleared" || entry.updatedBy === memberId) continue;
      const feedbackDate = asDate(entry.updatedAt);
      if (!feedbackDate) continue;
      const statusText =
        String(entry.action)[0]!.toUpperCase() + String(entry.action).slice(1);
      events.push({
        id: `comment-feedback-${comment.commentId}-${feedbackDate.toISOString()}`,
        date: feedbackDate,
        actor: String(entry.updatedByName ?? "Author"),
        action: "responded to your contribution on",
        target: titleFor(comment.proposalId),
        href: hrefFor(comment.proposalId)
          ? `${hrefFor(comment.proposalId)}#deliberation`
          : undefined,
        kind: "contribution",
        badge: statusText,
        summary: entry.note ? String(entry.note) : undefined,
      });
    }
  }

  for (const comment of endorsedComments) {
    const endorsement = (comment.upvoteEvents ?? []).find(
      (event: { memberId: string; at: Date }) => event.memberId === memberId,
    );
    const date = asDate(endorsement?.at);
    if (!date) continue;
    events.push({
      id: `endorsement-${comment.commentId}`,
      date,
      actor: "You",
      action: "endorsed a contribution on",
      target: titleFor(comment.proposalId),
      href: hrefFor(comment.proposalId)
        ? `${hrefFor(comment.proposalId)}#deliberation`
        : undefined,
      kind: "endorsement",
    });
  }

  for (const amendment of amendments) {
    const target = titleFor(amendment.proposalId);
    const href = hrefFor(amendment.proposalId);
    const createdAt = asDate(amendment.createdAt);
    if (createdAt)
      events.push({
        id: `amendment-${amendment.amendmentId}-created`,
        date: createdAt,
        actor: "You",
        action: "proposed a wording amendment on",
        target,
        href,
        kind: "amendment",
        badge: "Proposed",
      });

    const ballotOpenedAt = asDate(amendment.ballotOpenedAt);
    if (ballotOpenedAt)
      events.push({
        id: `amendment-${amendment.amendmentId}-ballot-opened`,
        date: ballotOpenedAt,
        actor: "Administration",
        action: "opened an amendment ballot for",
        target,
        href,
        kind: "amendment",
        badge: "Ballot open",
      });

    const decidedAt = asDate(amendment.ballotDecision?.decidedAt);
    if (decidedAt)
      events.push({
        id: `amendment-${amendment.amendmentId}-decided`,
        date: decidedAt,
        actor: "Administration",
        action: "decided the amendment ballot for",
        target,
        href,
        kind: "amendment",
        badge: resultLabel(String(amendment.ballotDecision.result ?? "")),
      });

    const approvedAt = asDate(amendment.formalApproval?.approvedAt);
    if (approvedAt)
      events.push({
        id: `amendment-${amendment.amendmentId}-accepted`,
        date: approvedAt,
        actor: "Administration",
        action: "formally accepted the amendment to",
        target,
        href,
        kind: "amendment",
        badge: "Accepted",
      });

    const appliedAt = asDate(amendment.appliedAt);
    if (appliedAt)
      events.push({
        id: `amendment-${amendment.amendmentId}-applied`,
        date: appliedAt,
        actor: "Administration",
        action: "applied the amendment to",
        target,
        href,
        kind: "amendment",
        badge: "Applied",
      });

    const resolvedAt = asDate(amendment.resolution?.resolvedAt);
    if (
      resolvedAt &&
      !ballotOpenedAt &&
      !approvedAt &&
      !appliedAt
    )
      events.push({
        id: `amendment-${amendment.amendmentId}-resolved`,
        date: resolvedAt,
        actor: "Administration",
        action: "completed review of the amendment to",
        target,
        href,
        kind: "amendment",
        badge: String(amendment.resolution?.outcome ?? "Reviewed"),
      });
  }

  const authoredIds = authoredProposals.map((proposal) =>
    String(proposal.proposalId),
  );
  if (authoredIds.length) {
    const [revisions, ballotResults, registry] = await Promise.all([
      db
        .collection("proposal_revisions")
        .find({ proposalId: { $in: authoredIds } })
        .toArray(),
      db
        .collection("ballot_results")
        .find({ proposalId: { $in: authoredIds } })
        .toArray(),
      db
        .collection("policy_registry")
        .find({ policyId: { $in: authoredIds } })
        .toArray(),
    ]);

    for (const revision of revisions) {
      if (revision.provenance === "legacy-backfill") continue;
      const proposal = proposalMap.get(String(revision.proposalId));
      const revisionDate = asDate(revision.createdAt);
      const proposalDate = asDate(proposal?.createdAt);
      if (!revisionDate || !proposalDate || revisionDate <= proposalDate)
        continue;
      events.push({
        id: `revision-${revision.revisionId}`,
        date: revisionDate,
        actor:
          revision.authorId === memberId ? "You" : "Administration",
        action: "updated the wording of",
        target: titleFor(revision.proposalId),
        href: hrefFor(revision.proposalId)
          ? `${hrefFor(revision.proposalId)}#revision-history-heading`
          : undefined,
        kind: "governance",
        badge: "Wording revision",
      });
    }

    for (const result of ballotResults) {
      const date = asDate(result.recordedAt);
      if (!date) continue;
      events.push({
        id: `ballot-result-${result.proposalId}`,
        date,
        actor: "Administration",
        action: "recorded the ballot result for",
        target: titleFor(result.proposalId),
        href: hrefFor(result.proposalId),
        kind: "governance",
        badge: resultLabel(String(result.result ?? "")),
      });
    }

    for (const policy of registry) {
      const proposalId = String(policy.proposalId ?? policy.policyId);
      const title = String(policy.title ?? titleFor(proposalId));
      const href = `/policies/${encodeURIComponent(String(policy.policyId))}/`;
      const ratifiedAt = asDate(policy.ratification?.ratifiedAt);
      if (ratifiedAt)
        events.push({
          id: `ratified-${policy.policyId}`,
          date: ratifiedAt,
          actor: "Administration",
          action: "ratified",
          target: title,
          href,
          kind: "governance",
          badge: "Ratified",
        });
      const publishedAt = asDate(policy.publishedAt);
      if (publishedAt)
        events.push({
          id: `published-${policy.policyId}`,
          date: publishedAt,
          actor: "Administration",
          action: "published",
          target: title,
          href,
          kind: "governance",
          badge: "Published",
        });
      const withdrawnAt = asDate(policy.withdrawnAt);
      if (withdrawnAt)
        events.push({
          id: `withdrawn-${policy.policyId}`,
          date: withdrawnAt,
          actor: "Administration",
          action: "withdrew",
          target: title,
          href,
          kind: "governance",
          badge: "Withdrawn",
        });
      const supersededAt = asDate(policy.supersededAt);
      if (supersededAt)
        events.push({
          id: `superseded-${policy.policyId}`,
          date: supersededAt,
          actor: "Administration",
          action: "superseded",
          target: title,
          href,
          kind: "governance",
          badge: "Superseded",
        });
    }
  }

  return events;
}

export type MemberCatchUpKind =
  | "discussion"
  | "amendment"
  | "decision"
  | "policy";

export interface MemberCatchUpItem {
  id: string;
  date: Date;
  kind: MemberCatchUpKind;
  actor: string;
  action: string;
  target: string;
  href?: string;
  badge?: string;
  summary?: string;
}

export interface MemberCatchUpGroup {
  proposalId: string;
  title: string;
  slug?: string;
  href?: string;
  lastDate: Date;
  items: MemberCatchUpItem[];
}

const excerpt = (value: unknown, max = 220) => {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
};

/**
 * Build a catch-up digest for proposals the member already participates in:
 * authored, voted on, discussed, endorsed or amended. It reports only records
 * that exist in the database and never infers a deadline, notification or
 * status transition that was not persisted.
 */
export async function buildMemberCatchUp(
  db: Db,
  memberId: string,
  since: Date,
  user: SessionUser | null = null,
): Promise<MemberCatchUpGroup[]> {
  const [votes, ownComments, endorsedComments, amendments, authoredProposals] =
    await Promise.all([
      findAllMemberVotes(db, memberId),
      db.collection("comments").find({ memberId }).toArray(),
      db
        .collection("comments")
        .find({ "upvoteEvents.memberId": memberId, memberId: { $ne: memberId } })
        .toArray(),
      db.collection("amendments").find({ authorId: memberId }).toArray(),
      db.collection("proposals").find({ authorId: memberId }).toArray(),
    ]);

  const proposalIds = new Set<string>();
  for (const vote of votes) proposalIds.add(String(vote.proposalId));
  for (const comment of ownComments) proposalIds.add(String(comment.proposalId));
  for (const comment of endorsedComments)
    proposalIds.add(String(comment.proposalId));
  for (const amendment of amendments)
    proposalIds.add(String(amendment.proposalId));
  for (const proposal of authoredProposals)
    proposalIds.add(String(proposal.proposalId));

  if (!proposalIds.size) return [];
  const ids = [...proposalIds];

  const [proposalDocs, newComments, allAmendments, revisions, results, registry] =
    await Promise.all([
      db.collection("proposals").find({ proposalId: { $in: ids } }).toArray(),
      db
        .collection("comments")
        .find({
          proposalId: { $in: ids },
          memberId: { $ne: memberId },
          createdAt: { $gte: since },
        })
        .sort({ createdAt: -1 })
        .limit(120)
        .toArray(),
      db.collection("amendments").find({ proposalId: { $in: ids } }).toArray(),
      db
        .collection("proposal_revisions")
        .find({
          proposalId: { $in: ids },
          createdAt: { $gte: since },
          provenance: { $ne: "legacy-backfill" },
        })
        .sort({ createdAt: -1 })
        .limit(60)
        .toArray(),
      db
        .collection("ballot_results")
        .find({ proposalId: { $in: ids }, recordedAt: { $gte: since } })
        .toArray(),
      db.collection("policy_registry").find({ proposalId: { $in: ids } }).toArray(),
    ]);

  const proposalMap = new Map<string, ProposalRecord>(
    proposalDocs.map((proposal) => [
      String(proposal.proposalId),
      proposal as unknown as ProposalRecord,
    ]),
  );
  const groups = new Map<string, MemberCatchUpGroup>();

  const add = (item: MemberCatchUpItem, proposalId: string) => {
    const proposal = proposalMap.get(proposalId);
    if (!proposal || !canViewProposal(proposal, user)) return;
    const href = proposal.slug ? `/proposals/${proposal.slug}/` : undefined;
    const group =
      groups.get(proposalId) ??
      ({
        proposalId,
        title: String(proposal.title),
        slug: proposal.slug,
        href,
        lastDate: item.date,
        items: [],
      } as MemberCatchUpGroup);
    group.items.push({ ...item, target: String(proposal.title), href: item.href ?? href });
    if (item.date > group.lastDate) group.lastDate = item.date;
    groups.set(proposalId, group);
  };

  for (const comment of newComments) {
    const date = asDate(comment.createdAt);
    if (!date || date < since) continue;
    add(
      {
        id: `catchup-comment-${comment.commentId}`,
        date,
        kind: "discussion",
        actor: String(comment.authorName ?? "A member"),
        action: "commented",
        target: "",
        badge: `Stance: ${String(comment.stance ?? "comment")}`,
        summary: excerpt(comment.body),
        href: proposalMap.get(String(comment.proposalId))?.slug
          ? `/proposals/${proposalMap.get(String(comment.proposalId))!.slug}/#deliberation`
          : undefined,
      },
      String(comment.proposalId),
    );
  }

  for (const comment of ownComments) {
    const history = Array.isArray(comment.feedbackHistory)
      ? comment.feedbackHistory
      : comment.feedback
        ? [{ action: comment.feedback.status, ...comment.feedback }]
        : [];
    for (const entry of history) {
      if (entry.action === "cleared" || entry.updatedBy === memberId) continue;
      const feedbackDate = asDate(entry.updatedAt);
      if (!feedbackDate || feedbackDate < since) continue;
      const statusText =
        String(entry.action)[0]!.toUpperCase() + String(entry.action).slice(1);
      add(
        {
          id: `catchup-feedback-${comment.commentId}-${feedbackDate.toISOString()}`,
          date: feedbackDate,
          kind: "discussion",
          actor: String(entry.updatedByName ?? "Author"),
          action: "responded to your contribution",
          target: "",
          badge: statusText,
          summary: entry.note ? excerpt(entry.note) : excerpt(comment.body),
          href: proposalMap.get(String(comment.proposalId))?.slug
            ? `/proposals/${proposalMap.get(String(comment.proposalId))!.slug}/#deliberation`
            : undefined,
        },
        String(comment.proposalId),
      );
    }
  }

  for (const revision of revisions) {
    const date = asDate(revision.createdAt);
    if (!date || date < since) continue;
    add(
      {
        id: `catchup-revision-${revision.revisionId}`,
        date,
        kind: "amendment",
        actor: revision.authorId === memberId ? "You" : "A member",
        action: "updated the wording",
        target: "",
        badge: "Wording revision",
        href: proposalMap.get(String(revision.proposalId))?.slug
          ? `/proposals/${proposalMap.get(String(revision.proposalId))!.slug}/#revision-history-heading`
          : undefined,
      },
      String(revision.proposalId),
    );
  }

  for (const amendment of allAmendments) {
    const proposalId = String(amendment.proposalId);
    const actor = amendment.authorId === memberId ? "You" : "A member";
    const amendmentHref = proposalMap.get(proposalId)?.slug
      ? `/proposals/${proposalMap.get(proposalId)!.slug}/#amendments-heading`
      : undefined;
    const milestones: Array<[unknown, string, string, string]> = [
      [amendment.createdAt, "proposed an amendment", "Proposed", actor],
      [amendment.ballotOpenedAt, "opened an amendment ballot", "Ballot open", "Administration"],
      [
        amendment.ballotDecision?.decidedAt,
        "decided the amendment ballot",
        resultLabel(String(amendment.ballotDecision?.result ?? "")),
        "Administration",
      ],
      [
        amendment.formalApproval?.approvedAt,
        "formally accepted an amendment",
        "Accepted",
        "Administration",
      ],
      [amendment.appliedAt, "applied an amendment", "Applied", "Administration"],
    ];
    for (const [value, action, badge, eventActor] of milestones) {
      const date = asDate(value);
      if (!date || date < since) continue;
      add(
        {
          id: `catchup-amendment-${amendment.amendmentId}-${badge}`,
          date,
          kind: "amendment",
          actor: eventActor,
          action,
          target: "",
          badge,
          href: amendmentHref,
        },
        proposalId,
      );
    }
  }

  for (const result of results) {
    const date = asDate(result.recordedAt);
    if (!date || date < since) continue;
    add(
      {
        id: `catchup-result-${result.proposalId}`,
        date,
        kind: "decision",
        actor: "Administration",
        action: "recorded the ballot result",
        target: "",
        badge: resultLabel(String(result.result ?? "")),
      },
      String(result.proposalId),
    );
  }

  for (const policy of registry) {
    const proposalId = String(policy.proposalId ?? policy.policyId);
    const href = `/policies/${encodeURIComponent(String(policy.policyId))}/`;
    const milestones: Array<[unknown, string, string]> = [
      [policy.ratification?.ratifiedAt, "ratified", "Ratified"],
      [policy.publishedAt, "published", "Published"],
      [policy.withdrawnAt, "withdrew", "Withdrawn"],
      [policy.supersededAt, "superseded", "Superseded"],
    ];
    for (const [value, action, badge] of milestones) {
      const date = asDate(value);
      if (!date || date < since) continue;
      const target = String(policy.title ?? proposalMap.get(proposalId)?.title ?? proposalId);
      const proposal = proposalMap.get(proposalId);
      if (proposal && !canViewProposal(proposal, user)) continue;
      const group =
        groups.get(proposalId) ??
        ({
          proposalId,
          title: target,
          slug: proposal?.slug,
          href,
          lastDate: date,
          items: [],
        } as MemberCatchUpGroup);
      group.items.push({
        id: `catchup-policy-${policy.policyId}-${badge}`,
        date,
        kind: "policy",
        actor: "Administration",
        action,
        target,
        href,
        badge,
      });
      if (date > group.lastDate) group.lastDate = date;
      groups.set(proposalId, group);
    }
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      items: [...group.items].sort(
        (left, right) => right.date.getTime() - left.date.getTime(),
      ),
    }))
    .sort((left, right) => right.lastDate.getTime() - left.lastDate.getTime());
}
