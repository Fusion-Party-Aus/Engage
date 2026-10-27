import { ObjectId, type Db } from "mongodb";
import { validPersonName } from "./auth.ts";
import type {
  CommentRecord,
  CommentStance,
  MemberRecord,
  MembershipStatus,
  PolicyProvenance,
  ProposalKind,
  ProposalRecord,
  ProposalStage,
  ProposalSummaryView,
  ProvenanceLink,
  SessionUser,
  UserRole,
  VoteChoice,
  VoteRecord,
  VoteTally,
} from "./types.ts";

export function getDefaultProvenanceLabel(category: string, kind: ProposalKind = "policy"): string {
  const isResolution = kind === "resolution";
  switch (category) {
    case "existing-repackaged":
      return isResolution
        ? "Preceding resolution · Equivalence unverified"
        : "Approved policy predecessor · Equivalence unverified";
    case "materially-revised":
      return isResolution
        ? "Preceding resolution · Materially revised"
        : "Approved policy predecessor · Materially revised";
    case "new-proposal":
      return isResolution
        ? "New resolution · No prior authority identified"
        : "New proposal · No prior policy identified";
    case "party-governance":
      return "Party Governance · Platform Review";
    case "draft-derived":
      return "Draft branch predecessor · Unapproved";
    case "unverified":
    default:
      return "Mapping unverified";
  }
}

export const VALID_STAGES: ProposalStage[] = [
  "propose",
  "deliberate",
  "decide",
  "implement",
  "archived",
];

export const VALID_KINDS: ProposalKind[] = ["policy", "resolution"];

export const VALID_STANCES: CommentStance[] = ["support", "concern", "amendment", "comment"];

export function isValidStage(value: unknown): value is ProposalStage {
  if (typeof value !== "string") return false;
  const raw = value.trim().toLowerCase();
  return (
    VALID_STAGES.includes(raw as ProposalStage) ||
    ["draft", "open", "voting", "adopted"].includes(raw)
  );
}

export function normalizeStage(value: unknown, fallback: ProposalStage = "deliberate"): ProposalStage {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (raw === "propose" || raw === "draft") return "propose";
  if (raw === "deliberate" || raw === "open") return "deliberate";
  if (raw === "decide" || raw === "voting") return "decide";
  if (raw === "implement" || raw === "adopted") return "implement";
  if (raw === "archived") return "archived";
  return fallback;
}

export function normalizeKind(value: unknown, proposalId = ""): ProposalKind {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (raw === "resolution" || raw === "governance") return "resolution";
  if (raw === "policy") return "policy";
  if (proposalId.toUpperCase().startsWith("GOV-")) return "resolution";
  return "policy";
}

export function validateStageTransition(fromStage: ProposalStage, toStage: ProposalStage): void {
  if (fromStage === toStage) return;
  if (!VALID_STAGES.includes(toStage)) {
    throw new Error(
      `Invalid lifecycle stage: '${toStage}'. Must be propose, deliberate, decide, implement, or archived.`
    );
  }
  if (fromStage === "propose" && (toStage === "decide" || toStage === "implement")) {
    throw new Error(
      "Proposals in Stage 1 (Propose) must undergo member deliberation before entering Decide or Implement."
    );
  }
  if (fromStage === "deliberate" && toStage === "implement") {
    throw new Error(
      "Proposals in Stage 2 (Deliberate) must be voted on in the Decide stage before entering Implement."
    );
  }
}

export function isProposalLocked(stage: ProposalStage, voteCount: number): boolean {
  return stage === "decide" || voteCount > 0;
}

export function parseOutcomes(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((o) => String(o).trim()).filter(Boolean);
  }
  if (typeof raw === "string") {
    return raw
      .split("\n")
      .map((line) => line.replace(/^[-*•\d.)\s]+/, "").trim())
      .filter(Boolean);
  }
  return [];
}

export function getSubstantiveChanges(
  existing: ProposalRecord,
  updates: {
    title?: string;
    summary?: string;
    outcomes?: string[];
    details?: string;
    attachmentUrl?: string;
    attachmentDescription?: string;
    kind?: string;
  },
): string[] {
  const changes: string[] = [];
  if (updates.title !== undefined && updates.title.trim() !== existing.title.trim()) {
    changes.push("title");
  }
  if (updates.summary !== undefined && updates.summary.trim() !== existing.summary.trim()) {
    changes.push("summary");
  }
  if (
    updates.details !== undefined &&
    updates.details.trim() !== (existing.details || "").trim()
  ) {
    changes.push("details");
  }
  if (
    updates.attachmentUrl !== undefined &&
    (updates.attachmentUrl.trim() || undefined) !== (existing.attachmentUrl?.trim() || undefined)
  ) {
    changes.push("attachmentUrl");
  }
  if (
    updates.attachmentDescription !== undefined &&
    (updates.attachmentDescription.trim() || undefined) !==
      (existing.attachmentDescription?.trim() || undefined)
  ) {
    changes.push("attachmentDescription");
  }
  if (
    updates.kind !== undefined &&
    normalizeKind(updates.kind, existing.proposalId) !==
      normalizeKind(existing.kind, existing.proposalId)
  ) {
    changes.push("kind");
  }
  if (updates.outcomes !== undefined) {
    const existingOutcomes = (existing.outcomes || []).map((o) => o.trim()).filter(Boolean);
    const newOutcomes = updates.outcomes.map((o) => o.trim()).filter(Boolean);
    if (
      existingOutcomes.length !== newOutcomes.length ||
      existingOutcomes.some((val, idx) => val !== newOutcomes[idx])
    ) {
      changes.push("outcomes");
    }
  }
  return changes;
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function normalizeProposalDoc(raw: any): ProposalRecord {
  const proposalId = String(raw.proposalId || raw.policyId || "");
  const space = String(raw.space || raw.category || "General");
  const summary = String(raw.summary || raw.statement || "");
  const stage = normalizeStage(raw.stage || raw.status || "deliberate");
  const kind = normalizeKind(raw.kind, proposalId);
  return {
    proposalId,
    slug: String(raw.slug || slugify(raw.title || proposalId)),
    title: String(raw.title || ""),
    space,
    spaceSummary: String(raw.spaceSummary || raw.categorySummary || ""),
    summary,
    outcomes: Array.isArray(raw.outcomes) ? raw.outcomes : [],
    details: String(raw.details || ""),
    detailHtml: raw.detailHtml ? String(raw.detailHtml) : undefined,
    provenance: raw.provenance || undefined,
    attachmentUrl: raw.attachmentUrl ? String(raw.attachmentUrl) : undefined,
    attachmentDescription: raw.attachmentDescription
      ? String(raw.attachmentDescription).trim()
      : undefined,
    stage,
    kind,
    implementationNote: raw.implementationNote ? String(raw.implementationNote) : undefined,
    authorId: raw.authorId ? String(raw.authorId) : undefined,
    authorName: raw.authorName ? String(raw.authorName) : undefined,
    createdAt: raw.createdAt ? new Date(raw.createdAt) : new Date(),
    updatedAt: raw.updatedAt ? new Date(raw.updatedAt) : new Date(),

    // Backwards compatibility aliases
    policyId: proposalId,
    category: space,
    categorySummary: String(raw.spaceSummary || raw.categorySummary || ""),
    statement: summary,
    status: stage,
    division: raw.division || space,
  };
}

export async function listProposals(
  db: Db,
  options: {
    includeArchived?: boolean;
    search?: string;
    space?: string;
    stage?: string;
    // Backwards compatibility filter options
    category?: string;
    status?: string;
    kind?: string;
    includeDrafts?: boolean;
  } = {},
): Promise<ProposalSummaryView[]> {
  const rawProposals = await db
    .collection<ProposalRecord>("proposals")
    .find({})
    .sort({ proposalId: 1 })
    .toArray();

  const allProposals = rawProposals.map(normalizeProposalDoc);

  const [allComments, allVotes] = await Promise.all([
    db.collection<CommentRecord>("comments").find({}).toArray(),
    db.collection<VoteRecord>("votes").find({}).toArray(),
  ]);

  const commentCounts = new Map<string, number>();
  for (const c of allComments) {
    const id = c.proposalId || (c as any).policyId;
    if (id) commentCounts.set(id, (commentCounts.get(id) ?? 0) + 1);
  }

  const voteMap = new Map<string, VoteTally>();
  for (const v of allVotes) {
    const id = v.proposalId || (v as any).policyId;
    if (!id) continue;
    const current = voteMap.get(id) ?? { approve: 0, abstain: 0, reject: 0, total: 0 };
    if (v.choice === "approve") current.approve += 1;
    else if (v.choice === "abstain") current.abstain += 1;
    else current.reject += 1;
    current.total += 1;
    voteMap.set(id, current);
  }

  const query = (options.search ?? "").trim().toLowerCase();
  const spaceFilter = (options.space ?? options.category ?? "").trim();
  const stageFilter =
    (options.stage && options.stage !== "all") || (options.status && options.status !== "all")
      ? normalizeStage(options.stage ?? options.status)
      : "";
  const allowArchived = options.includeArchived ?? options.includeDrafts ?? false;

  return allProposals
    .filter((p) => {
      if (!allowArchived && p.stage === "archived") {
        return false;
      }
      if (spaceFilter && spaceFilter !== "all" && p.space !== spaceFilter) {
        return false;
      }
      if (stageFilter && p.stage !== stageFilter) {
        return false;
      }
      if (query) {
        const haystack = `${p.proposalId} ${p.title} ${p.space} ${p.summary} ${p.details}`.toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      return true;
    })
    .map((p) => ({
      ...p,
      commentCount: commentCounts.get(p.proposalId) ?? 0,
      votes: voteMap.get(p.proposalId) ?? { approve: 0, abstain: 0, reject: 0, total: 0 },
    }));
}

export async function getProposalDetail(
  db: Db,
  idOrSlug: string,
  user: SessionUser | null,
): Promise<{
  proposal: ProposalSummaryView;
  comments: CommentRecord[];
  votesList: VoteRecord[];
  myVote: VoteChoice | null;
  myReason: string;
} | null> {
  const key = idOrSlug.trim();
  if (!key) return null;

  const col = db.collection<ProposalRecord>("proposals");
  const rawProposal =
    (await col.findOne({ slug: key })) ??
    (await col.findOne({ proposalId: key })) ??
    (await col.findOne({ policyId: key } as any));
  if (!rawProposal) return null;

  const proposal = normalizeProposalDoc(rawProposal);

  if (proposal.stage === "archived" && !user?.isStaff) {
    return null;
  }

  const [rawComments, votes] = await Promise.all([
    db
      .collection<CommentRecord>("comments")
      .find({ $or: [{ proposalId: proposal.proposalId }, { policyId: proposal.proposalId } as any] })
      .sort({ createdAt: 1 })
      .toArray(),
    db
      .collection<VoteRecord>("votes")
      .find({ $or: [{ proposalId: proposal.proposalId }, { policyId: proposal.proposalId } as any] })
      .sort({ updatedAt: -1 })
      .toArray(),
  ]);

  const comments = rawComments.map((c) => ({
    ...c,
    stance: VALID_STANCES.includes(c.stance) ? c.stance : "comment",
    upvotes: Array.isArray(c.upvotes) ? c.upvotes : [],
  }));

  const tally: VoteTally = { approve: 0, abstain: 0, reject: 0, total: 0 };
  let myVote: VoteChoice | null = null;
  let myReason = "";

  for (const v of votes) {
    if (v.choice === "approve") tally.approve += 1;
    else if (v.choice === "abstain") tally.abstain += 1;
    else tally.reject += 1;
    tally.total += 1;
    if (user && v.memberId === user.memberId) {
      myVote = v.choice;
      myReason = v.reason ?? "";
    }
  }

  return {
    proposal: {
      ...proposal,
      commentCount: comments.length,
      votes: tally,
    },
    comments,
    votesList: votes,
    myVote,
    myReason,
  };
}

export async function saveProposal(
  db: Db,
  user: SessionUser,
  body: Record<string, unknown>,
): Promise<ProposalRecord> {
  const col = db.collection<ProposalRecord>("proposals");
  const existingId =
    typeof body.proposalId === "string"
      ? body.proposalId.trim()
      : typeof body.policyId === "string"
        ? body.policyId.trim()
        : "";
  const existing = existingId ? await col.findOne({ proposalId: existingId }) : null;

  if (existing) {
    const isAuthorInPropose = existing.authorId === user.memberId && existing.stage === "propose";
    if (!user.isStaff && !isAuthorInPropose) {
      throw new Error("Moderator or Administrator access is required to edit this proposal.");
    }
  } else if (!user.canParticipate && !user.isStaff) {
    throw new Error("Your membership must be verified before you can submit a proposal.");
  }

  if (existing) {
    // Validate stage transition if changing stage
    if (body.stage !== undefined || body.status !== undefined) {
      const rawStageInput = body.stage !== undefined ? body.stage : body.status;
      if (!isValidStage(rawStageInput)) {
        throw new Error(
          `Invalid lifecycle stage: '${String(rawStageInput)}'. Must be propose, deliberate, decide, implement, or archived.`
        );
      }
      const targetStage = normalizeStage(rawStageInput, existing.stage);
      validateStageTransition(existing.stage, targetStage);
    }

    // Server-enforced ballot integrity lock
    const voteCount = await db.collection<VoteRecord>("votes").countDocuments({
      $or: [{ proposalId: existing.proposalId }, { policyId: existing.proposalId } as any],
    });
    const locked = isProposalLocked(existing.stage, voteCount);

    if (locked) {
      const candidateOutcomes = body.outcomes !== undefined ? parseOutcomes(body.outcomes) : undefined;
      const substantiveChanges = getSubstantiveChanges(existing, {
        title: typeof body.title === "string" ? body.title : undefined,
        summary:
          typeof body.summary === "string"
            ? body.summary
            : typeof body.statement === "string"
              ? body.statement
              : undefined,
        outcomes: candidateOutcomes,
        details: typeof body.details === "string" ? body.details : undefined,
        attachmentUrl: typeof body.attachmentUrl === "string" ? body.attachmentUrl : undefined,
        attachmentDescription:
          typeof body.attachmentDescription === "string" ? body.attachmentDescription : undefined,
        kind: typeof body.kind === "string" ? body.kind : undefined,
      });

      if (substantiveChanges.length > 0) {
        const reason =
          voteCount > 0
            ? `voting has already begun and ${voteCount} member vote(s) have been cast`
            : `the proposal is active in the Decide stage`;
        throw new Error(
          `Cannot modify substantive proposal content (${substantiveChanges.join(", ")}) because ${reason}. Substantive text is locked to protect ballot integrity. Create a revised proposal to submit modified motion text.`
        );
      }
    }
  }

  // Quick stage / implementationNote update by staff
  if (
    existing &&
    user.isStaff &&
    Object.keys(body).every((k) =>
      ["proposalId", "policyId", "stage", "status", "implementationNote"].includes(k),
    ) &&
    (body.stage !== undefined || body.status !== undefined || body.implementationNote !== undefined)
  ) {
    const stage =
      body.stage !== undefined || body.status !== undefined
        ? normalizeStage(body.stage ?? body.status, existing.stage)
        : existing.stage;
    const implementationNote =
      typeof body.implementationNote === "string"
        ? body.implementationNote.trim()
        : existing.implementationNote;
    const updatedAt = new Date();
    await col.updateOne(
      { proposalId: existing.proposalId },
      { $set: { stage, implementationNote, updatedAt } },
    );
    return { ...existing, stage, implementationNote, updatedAt };
  }

  const title = typeof body.title === "string" ? body.title.trim() : existing?.title ?? "";
  if (title.length < 4 || title.length > 200) {
    throw new Error("Title must be between 4 and 200 characters.");
  }

  const space =
    typeof body.space === "string" && body.space.trim()
      ? body.space.trim()
      : typeof body.category === "string" && body.category.trim()
        ? body.category.trim()
        : existing?.space ?? "General";
  if (space.length < 2 || space.length > 100) {
    throw new Error("Space / topic must be between 2 and 100 characters.");
  }

  const rawSummary =
    typeof body.summary === "string"
      ? body.summary.trim()
      : typeof body.statement === "string"
        ? body.statement.trim()
        : existing?.summary ?? "";
  if (rawSummary.length < 10 || rawSummary.length > 2000) {
    throw new Error("Proposal summary must be between 10 and 2,000 characters.");
  }

  let outcomes: string[] = existing?.outcomes ?? [];
  if (Array.isArray(body.outcomes)) {
    outcomes = body.outcomes.map((o) => String(o).trim()).filter(Boolean);
  } else if (typeof body.outcomes === "string") {
    outcomes = body.outcomes
      .split("\n")
      .map((line) => line.replace(/^[-*•\d.)\s]+/, "").trim())
      .filter(Boolean);
  }

  const details = typeof body.details === "string" ? body.details.trim() : existing?.details ?? "";
  const attachmentUrl =
    typeof body.attachmentUrl === "string"
      ? body.attachmentUrl.trim()
      : existing?.attachmentUrl ?? "";
  if (attachmentUrl && !/^(https?:\/\/|\/)/i.test(attachmentUrl)) {
    throw new Error("Supporting link or image URL must start with https:// or /.");
  }

  const attachmentDescription =
    typeof body.attachmentDescription === "string"
      ? body.attachmentDescription.trim()
      : existing?.attachmentDescription ?? "";

  const kind = normalizeKind(
    body.kind ?? existing?.kind ?? "policy",
    existing?.proposalId ?? "",
  );

  const implementationNote =
    typeof body.implementationNote === "string"
      ? body.implementationNote.trim()
      : existing?.implementationNote ?? "";

  // Non-staff member submissions always start in "propose" stage
  const stage: ProposalStage = user.isStaff
    ? normalizeStage(body.stage ?? body.status, existing?.stage ?? "propose")
    : existing?.stage ?? "propose";

  const now = new Date();

  let provenance: PolicyProvenance | undefined = existing?.provenance;
  if (user.isStaff && body.provenance !== undefined) {
    if (!body.provenance || (typeof body.provenance === "object" && !(body.provenance as any).category)) {
      provenance = undefined;
    } else if (typeof body.provenance === "object") {
      const rawProv = body.provenance as Record<string, any>;
      const category = String(rawProv.category || "unverified").trim();
      const label = String(rawProv.label || "").trim() || getDefaultProvenanceLabel(category, kind);
      const summary = String(rawProv.summary || "").trim();
      const uncertaintyNote = rawProv.uncertaintyNote ? String(rawProv.uncertaintyNote).trim() : undefined;

      let lineage: ProvenanceLink[] = [];
      if (Array.isArray(rawProv.lineage)) {
        lineage = rawProv.lineage
          .map((l: any) => ({
            label: String(l.label || "").trim(),
            url: l.url ? String(l.url).trim() : null,
            description: String(l.description || "").trim(),
          }))
          .filter((l: ProvenanceLink) => l.label);
      }

      let valuesAlignment: string[] = [];
      if (Array.isArray(rawProv.valuesAlignment)) {
        valuesAlignment = rawProv.valuesAlignment
          .map((v: any) => String(v).trim())
          .filter(Boolean);
      }

      provenance = {
        category,
        classification: category,
        label,
        summary,
        uncertaintyNote,
        lineage,
        valuesAlignment,
        flaggedNewInStaticExport: category === "new-proposal",
        lineageVerified: category !== "unverified",
      };
    }
  }

  if (existing) {
    const updated: ProposalRecord = {
      ...existing,
      title,
      space,
      summary: rawSummary,
      outcomes,
      details,
      attachmentUrl: attachmentUrl || undefined,
      attachmentDescription: attachmentDescription || undefined,
      kind,
      implementationNote: implementationNote || undefined,
      stage,
      provenance,
      updatedAt: now,
    };
    const updateSet: Record<string, any> = {
      title: updated.title,
      space: updated.space,
      summary: updated.summary,
      outcomes: updated.outcomes,
      details: updated.details,
      attachmentUrl: updated.attachmentUrl,
      attachmentDescription: updated.attachmentDescription,
      kind: updated.kind,
      implementationNote: updated.implementationNote,
      stage: updated.stage,
      updatedAt: now,
    };
    if (user.isStaff && body.provenance !== undefined) {
      updateSet.provenance = provenance;
    }

    await col.updateOne(
      { proposalId: existing.proposalId },
      {
        $set: updateSet,
        ...(user.isStaff && body.provenance === null ? { $unset: { provenance: 1 } } : {}),
      },
    );
    return updated;
  }

  const count = await col.countDocuments();
  const proposalId =
    existingId || `PROP-${String(count + 1).padStart(3, "0")}-${crypto.randomUUID().slice(0, 4).toUpperCase()}`;
  const baseSlug = slugify(title) || proposalId.toLowerCase();
  const slugConflict = await col.findOne({ slug: baseSlug });
  const slug = slugConflict ? `${baseSlug}-${proposalId.toLowerCase()}` : baseSlug;

  const createdKind = normalizeKind(body.kind, proposalId);

  const created: ProposalRecord = {
    proposalId,
    slug,
    title,
    space,
    summary: rawSummary,
    outcomes,
    details,
    ...(attachmentUrl ? { attachmentUrl } : {}),
    ...(attachmentDescription ? { attachmentDescription } : {}),
    kind: createdKind,
    ...(implementationNote ? { implementationNote } : {}),
    stage,
    provenance,
    authorId: user.memberId,
    authorName: user.name || "Verified Member",
    createdAt: now,
    updatedAt: now,
  };

  await col.insertOne(created);
  return created;
}

export async function deleteProposal(db: Db, user: SessionUser, proposalId: string): Promise<void> {
  const id = proposalId.trim();
  if (!id) throw new Error("Proposal ID is required.");
  const col = db.collection<ProposalRecord>("proposals");
  const existing = await col.findOne({ proposalId: id });
  if (!existing) throw new Error("Proposal not found.");

  const isAuthorInPropose = existing.authorId === user.memberId && existing.stage === "propose";
  if (!user.isAdmin && !isAuthorInPropose) {
    throw new Error("Administrator access is required to delete this proposal.");
  }

  await col.deleteOne({ proposalId: id });
  await Promise.all([
    db.collection("comments").deleteMany({ proposalId: id }),
    db.collection("votes").deleteMany({ proposalId: id }),
  ]);
}

export async function addComment(
  db: Db,
  user: SessionUser,
  body: Record<string, unknown>,
): Promise<CommentRecord> {
  if (!user.canParticipate) {
    throw new Error("Your membership must be verified before you can contribute to deliberation.");
  }

  const proposalId =
    typeof body.proposalId === "string"
      ? body.proposalId.trim()
      : typeof body.policyId === "string"
        ? body.policyId.trim()
        : "";
  const proposal = await db.collection<ProposalRecord>("proposals").findOne({ proposalId });
  if (!proposal || proposal.stage === "archived") {
    throw new Error("This proposal is not open for deliberation.");
  }

  const text = typeof body.body === "string" ? body.body.trim() : "";
  if (text.length < 5 || text.length > 5000) {
    throw new Error("Contribution must be between 5 and 5,000 characters.");
  }

  const rawStance = String(body.stance || body.kind || "comment");
  const stance: CommentStance = VALID_STANCES.includes(rawStance as CommentStance)
    ? (rawStance as CommentStance)
    : "comment";

  const record: CommentRecord = {
    commentId: `cmt-${crypto.randomUUID()}`,
    proposalId: proposal.proposalId,
    memberId: user.memberId,
    authorName: user.name || "Verified Member",
    stance,
    body: text,
    upvotes: [],
    createdAt: new Date(),
  };

  await db.collection<CommentRecord>("comments").insertOne(record);
  return record;
}

export async function toggleUpvoteComment(
  db: Db,
  user: SessionUser,
  commentId: string,
): Promise<{ upvotes: string[]; count: number; endorsed: boolean; hasUpvoted: boolean }> {
  if (!user.canParticipate) {
    throw new Error("Your membership must be verified to endorse deliberation points.");
  }
  const id = commentId.trim();
  const col = db.collection<CommentRecord>("comments");
  const existing = await col.findOne({ commentId: id });
  if (!existing) throw new Error("Comment not found.");

  const current = Array.isArray(existing.upvotes) ? existing.upvotes : [];
  const hasEndorsed = current.includes(user.memberId);
  const updated = hasEndorsed
    ? current.filter((m) => m !== user.memberId)
    : [...current, user.memberId];

  await col.updateOne({ commentId: id }, { $set: { upvotes: updated } });
  return {
    upvotes: updated,
    count: updated.length,
    endorsed: !hasEndorsed,
    hasUpvoted: !hasEndorsed,
  };
}

export async function deleteComment(db: Db, user: SessionUser, commentId: string): Promise<void> {
  const id = commentId.trim();
  if (!id) throw new Error("Comment ID is required.");
  const col = db.collection<CommentRecord>("comments");
  const existing = await col.findOne({ commentId: id });
  if (!existing) throw new Error("Comment not found.");
  if (existing.memberId !== user.memberId && !user.isStaff) {
    throw new Error("You can only delete your own contributions.");
  }
  await col.deleteOne({ commentId: id });
}

export async function castVote(
  db: Db,
  user: SessionUser,
  body: Record<string, unknown>,
): Promise<{ choice: VoteChoice; votes: VoteTally }> {
  if (!user.canParticipate) {
    throw new Error("Your membership must be verified before you can participate in decisions.");
  }

  const proposalId =
    typeof body.proposalId === "string"
      ? body.proposalId.trim()
      : typeof body.policyId === "string"
        ? body.policyId.trim()
        : "";
  const proposal = await db.collection<ProposalRecord>("proposals").findOne({ proposalId });
  if (!proposal) throw new Error("Proposal not found.");
  if (proposal.stage !== "decide") {
    throw new Error("This proposal is not currently in the Decide stage.");
  }

  const rawChoice = typeof body.choice === "string" ? body.choice.trim().toLowerCase() : "";
  if (!["approve", "abstain", "reject", "do-not-approve"].includes(rawChoice)) {
    throw new Error("Choose Approve, Abstain, or Reject.");
  }
  const choice: VoteChoice =
    rawChoice === "approve" ? "approve" : rawChoice === "abstain" ? "abstain" : "reject";
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : "";

  const votesCol = db.collection<VoteRecord>("votes");
  await votesCol.updateOne(
    { proposalId: proposal.proposalId, memberId: user.memberId },
    {
      $set: {
        proposalId: proposal.proposalId,
        memberId: user.memberId,
        authorName: user.name || "Verified Member",
        choice,
        ...(reason ? { reason } : { reason: "" }),
        updatedAt: new Date(),
      },
    },
    { upsert: true },
  );

  const allVotes = await votesCol.find({ proposalId: proposal.proposalId }).toArray();
  const votes: VoteTally = { approve: 0, abstain: 0, reject: 0, total: 0 };
  for (const v of allVotes) {
    if (v.choice === "approve") votes.approve += 1;
    else if (v.choice === "abstain") votes.abstain += 1;
    else votes.reject += 1;
    votes.total += 1;
  }

  return { choice, votes };
}

export async function listUserActivity(
  db: Db,
  memberId: string,
): Promise<{
  proposals: ProposalRecord[];
  comments: Array<CommentRecord & { proposalTitle: string; proposalSlug: string }>;
  votes: Array<VoteRecord & { proposalTitle: string; proposalSlug: string; proposalStage: ProposalStage }>;
}> {
  const [proposals, comments, votes] = await Promise.all([
    db.collection<ProposalRecord>("proposals").find({}).toArray(),
    db.collection<CommentRecord>("comments").find({ memberId }).sort({ createdAt: -1 }).toArray(),
    db.collection<VoteRecord>("votes").find({ memberId }).sort({ updatedAt: -1 }).toArray(),
  ]);

  const proposalMap = new Map(proposals.map((p) => [p.proposalId, p]));

  return {
    proposals: proposals.filter((p) => p.authorId === memberId),
    comments: comments.map((c) => {
      const p = proposalMap.get(c.proposalId);
      return {
        ...c,
        proposalTitle: p?.title ?? c.proposalId,
        proposalSlug: p?.slug ?? c.proposalId,
      };
    }),
    votes: votes.map((v) => {
      const p = proposalMap.get(v.proposalId);
      return {
        ...v,
        proposalTitle: p?.title ?? v.proposalId,
        proposalSlug: p?.slug ?? v.proposalId,
        proposalStage: p?.stage ?? "deliberate",
      };
    }),
  };
}

export async function listMembers(db: Db, search = ""): Promise<MemberRecord[]> {
  const [users, roles, memberships] = await Promise.all([
    db.collection("user").find({}).sort({ createdAt: -1 }).toArray(),
    db.collection<{ memberId: string; role: UserRole }>("application_roles").find({}).toArray(),
    db.collection<{ memberId: string; status: MembershipStatus }>("memberships").find({}).toArray(),
  ]);

  const roleMap = new Map<string, UserRole>();
  for (const r of roles) {
    if (r.role === "administrator" || !roleMap.has(r.memberId)) {
      roleMap.set(r.memberId, r.role);
    }
  }
  const statusMap = new Map<string, MembershipStatus>(memberships.map((m) => [m.memberId, m.status]));
  const q = search.trim().toLowerCase();

  return users
    .map((u) => {
      const memberId = String(u._id);
      return {
        memberId,
        name: String(u.name ?? ""),
        email: String(u.email ?? ""),
        role: roleMap.get(memberId) ?? "member",
        status: statusMap.get(memberId) ?? "pending",
        disabled: Boolean(u.disabled),
        emailVerified: Boolean(u.emailVerified),
        createdAt: u.createdAt instanceof Date ? u.createdAt : undefined,
      };
    })
    .filter((m) => !q || `${m.name} ${m.email} ${m.role} ${m.status}`.toLowerCase().includes(q));
}

export async function saveMember(
  db: Db,
  actor: SessionUser,
  body: Record<string, unknown>,
  create = false,
): Promise<{ memberId: string }> {
  if (!actor.isAdmin) {
    throw new Error("Administrator role required.");
  }

  const name = body.name === undefined ? undefined : validPersonName(body.name);
  if (name === null || (create && !name)) {
    throw new Error("Enter a full name (2–100 characters).");
  }

  const role = body.role !== undefined ? String(body.role) : undefined;
  if (role !== undefined && !["member", "moderator", "administrator"].includes(role)) {
    throw new Error("Choose Member, Moderator or Administrator.");
  }

  const status = body.status !== undefined ? String(body.status) : undefined;
  if (status !== undefined && !["pending", "verified", "suspended"].includes(status)) {
    throw new Error("Choose a valid membership status.");
  }

  const disabled = body.disabled !== undefined ? Boolean(body.disabled) : undefined;
  const users = db.collection("user");
  const now = new Date();
  let memberId: string;

  if (create) {
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error("Enter a valid email address.");
    }
    if (await users.findOne({ email })) {
      throw new Error("An account with that email already exists.");
    }
    const saved = await users.insertOne({
      name,
      email,
      emailVerified: false,
      disabled: disabled === true,
      createdAt: now,
      updatedAt: now,
    });
    memberId = saved.insertedId.toString();
  } else {
    if (typeof body.memberId !== "string" || !/^[a-f0-9]{24}$/.test(body.memberId)) {
      throw new Error("Choose a valid member account.");
    }
    memberId = body.memberId;
    if (!(await users.findOne({ _id: new ObjectId(memberId) }))) {
      throw new Error("Account not found.");
    }
    if (
      memberId === actor.memberId &&
      (disabled === true ||
        (role !== undefined && role !== "administrator") ||
        (status !== undefined && status !== "verified"))
    ) {
      throw new Error("You cannot remove your own administrator access.");
    }
    await users.updateOne(
      { _id: new ObjectId(memberId) },
      {
        $set: {
          ...(name ? { name } : {}),
          ...(disabled !== undefined ? { disabled } : {}),
          updatedAt: now,
        },
      },
    );
  }

  if (role !== undefined) {
    await db.collection("application_roles").deleteMany({ memberId });
    if (role !== "member") {
      await db.collection("application_roles").updateOne(
        { memberId, role },
        { $setOnInsert: { memberId, role, grantedAt: now, grantedBy: actor.memberId } },
        { upsert: true },
      );
    }
  }

  if (status !== undefined) {
    await db.collection("memberships").updateOne(
      { memberId },
      {
        $set: {
          memberId,
          status,
          updatedAt: now,
          updatedBy: actor.memberId,
        },
      },
      { upsert: true },
    );
  }

  if (disabled === true) {
    await db.collection("session").deleteMany({ userId: { $in: [memberId, new ObjectId(memberId)] } });
  }

  return { memberId };
}

// Keep aliases for any callers
export const listPolicies = listProposals;
export const getPolicyDetail = getProposalDetail;
export const savePolicy = saveProposal;
export const deletePolicy = deleteProposal;
