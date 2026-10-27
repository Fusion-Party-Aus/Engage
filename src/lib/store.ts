import { ObjectId, type Db } from "mongodb";
import { validPersonName } from "./auth.ts";
import type {
  CommentKind,
  CommentRecord,
  MemberRecord,
  MembershipStatus,
  PolicyRecord,
  PolicyStatus,
  PolicySummaryView,
  ProposalKind,
  SessionUser,
  UserRole,
  VoteChoice,
  VoteRecord,
  VoteTally,
} from "./types.ts";

const VALID_STATUSES: PolicyStatus[] = ["draft", "open", "voting", "adopted", "archived"];

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export async function listPolicies(
  db: Db,
  options: {
    includeDrafts?: boolean;
    search?: string;
    category?: string;
    status?: string;
    kind?: string;
  } = {},
): Promise<PolicySummaryView[]> {
  const allPolicies = await db
    .collection<PolicyRecord>("policies")
    .find({})
    .sort({ policyId: 1 })
    .toArray();

  const [allComments, allVotes] = await Promise.all([
    db.collection<CommentRecord>("comments").find({}).toArray(),
    db.collection<VoteRecord>("votes").find({}).toArray(),
  ]);

  const commentCounts = new Map<string, number>();
  for (const c of allComments) {
    commentCounts.set(c.policyId, (commentCounts.get(c.policyId) ?? 0) + 1);
  }

  const voteMap = new Map<string, VoteTally>();
  for (const v of allVotes) {
    const current = voteMap.get(v.policyId) ?? { approve: 0, reject: 0, total: 0 };
    if (v.choice === "approve") current.approve += 1;
    else current.reject += 1;
    current.total += 1;
    voteMap.set(v.policyId, current);
  }

  const query = (options.search ?? "").trim().toLowerCase();
  const catFilter = (options.category ?? "").trim();
  const statusFilter = (options.status ?? "").trim();
  const kindFilter = (options.kind ?? "").trim();

  return allPolicies
    .filter((p) => {
      const recordKind = p.kind ?? "policy";
      if (!options.includeDrafts && (p.status === "draft" || p.status === "archived")) {
        return false;
      }
      if (kindFilter && kindFilter !== "all" && recordKind !== kindFilter) {
        return false;
      }
      if (catFilter && catFilter !== "all" && p.category !== catFilter) {
        return false;
      }
      if (statusFilter && statusFilter !== "all" && p.status !== statusFilter) {
        return false;
      }
      if (query) {
        const haystack = `${p.policyId} ${p.title} ${p.category} ${p.division} ${p.statement}`.toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      return true;
    })
    .map((p) => ({
      ...p,
      kind: p.kind ?? "policy",
      commentCount: commentCounts.get(p.policyId) ?? 0,
      votes: voteMap.get(p.policyId) ?? { approve: 0, reject: 0, total: 0 },
    }));
}

export async function getPolicyDetail(
  db: Db,
  idOrSlug: string,
  user: SessionUser | null,
): Promise<{
  policy: PolicySummaryView;
  comments: CommentRecord[];
  myVote: VoteChoice | null;
} | null> {
  const key = idOrSlug.trim();
  if (!key) return null;

  const col = db.collection<PolicyRecord>("policies");
  const policy = (await col.findOne({ slug: key })) ?? (await col.findOne({ policyId: key }));
  if (!policy) return null;

  if ((policy.status === "draft" || policy.status === "archived") && !user?.isStaff) {
    return null;
  }

  const [comments, votes] = await Promise.all([
    db
      .collection<CommentRecord>("comments")
      .find({ policyId: policy.policyId })
      .sort({ createdAt: 1 })
      .toArray(),
    db.collection<VoteRecord>("votes").find({ policyId: policy.policyId }).toArray(),
  ]);

  const tally: VoteTally = { approve: 0, reject: 0, total: 0 };
  let myVote: VoteChoice | null = null;
  for (const v of votes) {
    if (v.choice === "approve") tally.approve += 1;
    else tally.reject += 1;
    tally.total += 1;
    if (user && v.memberId === user.memberId) {
      myVote = v.choice === "approve" ? "approve" : "reject";
    }
  }

  return {
    policy: {
      ...policy,
      kind: policy.kind ?? "policy",
      commentCount: comments.length,
      votes: tally,
    },
    comments,
    myVote,
  };
}

export async function savePolicy(
  db: Db,
  user: SessionUser,
  body: Record<string, unknown>,
): Promise<PolicyRecord> {
  if (!user.isStaff) {
    throw new Error("Moderator or Administrator access is required to manage proposals.");
  }

  const col = db.collection<PolicyRecord>("policies");
  const existingId = typeof body.policyId === "string" ? body.policyId.trim() : "";
  const existing = existingId ? await col.findOne({ policyId: existingId }) : null;

  // Allow quick status-only update
  if (
    existing &&
    Object.keys(body).every((k) => k === "policyId" || k === "status") &&
    typeof body.status === "string"
  ) {
    if (!VALID_STATUSES.includes(body.status as PolicyStatus)) {
      throw new Error("Invalid proposal status.");
    }
    const status = body.status as PolicyStatus;
    const updatedAt = new Date();
    await col.updateOne({ policyId: existing.policyId }, { $set: { status, updatedAt } });
    return { ...existing, status, updatedAt };
  }

  const kind: ProposalKind =
    body.kind === "proposal"
      ? "proposal"
      : body.kind === "policy"
        ? "policy"
        : existing?.kind ?? "policy";

  const title = typeof body.title === "string" ? body.title.trim() : existing?.title ?? "";
  if (title.length < 4 || title.length > 200) {
    throw new Error("Title must be between 4 and 200 characters.");
  }

  const category =
    typeof body.category === "string"
      ? body.category.trim()
      : existing?.category ?? (kind === "proposal" ? "Platform & Branding Review" : "General");
  if (category.length < 2 || category.length > 100) {
    throw new Error("Category must be between 2 and 100 characters.");
  }

  const division =
    typeof body.division === "string" && body.division.trim()
      ? body.division.trim()
      : existing?.division ?? (kind === "proposal" ? "Party & Organisation" : "Reclaim Our Future");

  const statement = typeof body.statement === "string" ? body.statement.trim() : existing?.statement ?? "";
  if (statement.length < 10 || statement.length > 2000) {
    throw new Error("Summary statement must be between 10 and 2,000 characters.");
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

  const statusInput = typeof body.status === "string" ? (body.status as PolicyStatus) : existing?.status ?? "open";
  const status: PolicyStatus = VALID_STATUSES.includes(statusInput) ? statusInput : "open";

  const now = new Date();

  if (existing) {
    const updated: PolicyRecord = {
      ...existing,
      kind,
      title,
      category,
      division,
      statement,
      outcomes,
      details,
      attachmentUrl: attachmentUrl || undefined,
      status,
      updatedAt: now,
    };
    await col.updateOne(
      { policyId: existing.policyId },
      {
        $set: {
          kind: updated.kind,
          title: updated.title,
          category: updated.category,
          division: updated.division,
          statement: updated.statement,
          outcomes: updated.outcomes,
          details: updated.details,
          attachmentUrl: updated.attachmentUrl,
          status: updated.status,
          updatedAt: now,
        },
      },
    );
    return updated;
  }

  const count = await col.countDocuments();
  const prefix = kind === "proposal" ? "PROP" : "POL";
  const policyId =
    existingId || `${prefix}-${String(count + 1).padStart(3, "0")}-${crypto.randomUUID().slice(0, 4).toUpperCase()}`;
  const baseSlug = slugify(title) || policyId.toLowerCase();
  const slugConflict = await col.findOne({ slug: baseSlug });
  const slug = slugConflict ? `${baseSlug}-${policyId.toLowerCase()}` : baseSlug;

  const created: PolicyRecord = {
    policyId,
    slug,
    kind,
    title,
    division,
    category,
    statement,
    outcomes,
    details,
    ...(attachmentUrl ? { attachmentUrl } : {}),
    status,
    createdAt: now,
    updatedAt: now,
  };

  await col.insertOne(created);
  return created;
}

export async function deletePolicy(db: Db, user: SessionUser, policyId: string): Promise<void> {
  if (!user.isAdmin) {
    throw new Error("Administrator access is required to delete a proposal.");
  }
  const id = policyId.trim();
  if (!id) throw new Error("Proposal ID is required.");
  const deleted = await db.collection("policies").deleteOne({ policyId: id });
  if (!deleted.deletedCount) throw new Error("Proposal not found.");
  await Promise.all([
    db.collection("comments").deleteMany({ policyId: id }),
    db.collection("votes").deleteMany({ policyId: id }),
  ]);
}

export async function addComment(
  db: Db,
  user: SessionUser,
  body: Record<string, unknown>,
): Promise<CommentRecord> {
  if (!user.canParticipate) {
    throw new Error("Your party membership must be verified before you can post comments.");
  }

  const policyId = typeof body.policyId === "string" ? body.policyId.trim() : "";
  const policy = await db.collection<PolicyRecord>("policies").findOne({ policyId });
  if (!policy || policy.status === "draft" || policy.status === "archived") {
    throw new Error("This proposal is not open for discussion.");
  }

  const text = typeof body.body === "string" ? body.body.trim() : "";
  if (text.length < 5 || text.length > 5000) {
    throw new Error("Comment must be between 5 and 5,000 characters.");
  }

  const kind: CommentKind = body.kind === "amendment" ? "amendment" : "comment";
  const record: CommentRecord = {
    commentId: `cmt-${crypto.randomUUID()}`,
    policyId: policy.policyId,
    memberId: user.memberId,
    authorName: user.name || "Verified Member",
    kind,
    body: text,
    createdAt: new Date(),
  };

  await db.collection<CommentRecord>("comments").insertOne(record);
  return record;
}

export async function deleteComment(db: Db, user: SessionUser, commentId: string): Promise<void> {
  const id = commentId.trim();
  if (!id) throw new Error("Comment ID is required.");
  const col = db.collection<CommentRecord>("comments");
  const existing = await col.findOne({ commentId: id });
  if (!existing) throw new Error("Comment not found.");
  if (existing.memberId !== user.memberId && !user.isStaff) {
    throw new Error("You can only delete your own comments.");
  }
  await col.deleteOne({ commentId: id });
}

export async function castVote(
  db: Db,
  user: SessionUser,
  body: Record<string, unknown>,
): Promise<{ choice: VoteChoice; votes: VoteTally }> {
  if (!user.canParticipate) {
    throw new Error("Your party membership must be verified before you can vote.");
  }

  const policyId = typeof body.policyId === "string" ? body.policyId.trim() : "";
  const policy = await db.collection<PolicyRecord>("policies").findOne({ policyId });
  if (!policy) throw new Error("Proposal not found.");
  if (policy.status !== "voting") {
    throw new Error("Voting is not currently open on this proposal.");
  }

  const rawChoice = typeof body.choice === "string" ? body.choice.trim() : "";
  if (rawChoice !== "approve" && rawChoice !== "reject" && rawChoice !== "do-not-approve") {
    throw new Error("Choose Approve or Reject.");
  }
  const choice: VoteChoice = rawChoice === "approve" ? "approve" : "reject";

  const votesCol = db.collection<VoteRecord>("votes");
  await votesCol.updateOne(
    { policyId: policy.policyId, memberId: user.memberId },
    {
      $set: {
        policyId: policy.policyId,
        memberId: user.memberId,
        choice,
        updatedAt: new Date(),
      },
    },
    { upsert: true },
  );

  const allVotes = await votesCol.find({ policyId: policy.policyId }).toArray();
  const votes: VoteTally = { approve: 0, reject: 0, total: 0 };
  for (const v of allVotes) {
    if (v.choice === "approve") votes.approve += 1;
    else votes.reject += 1;
    votes.total += 1;
  }

  return { choice, votes };
}

export async function listUserActivity(
  db: Db,
  memberId: string,
): Promise<{
  comments: Array<CommentRecord & { policyTitle: string; policySlug: string }>;
  votes: Array<VoteRecord & { policyTitle: string; policySlug: string; policyStatus: PolicyStatus }>;
}> {
  const [policies, comments, votes] = await Promise.all([
    db.collection<PolicyRecord>("policies").find({}).toArray(),
    db.collection<CommentRecord>("comments").find({ memberId }).sort({ createdAt: -1 }).toArray(),
    db.collection<VoteRecord>("votes").find({ memberId }).sort({ updatedAt: -1 }).toArray(),
  ]);

  const policyMap = new Map(policies.map((p) => [p.policyId, p]));

  return {
    comments: comments.map((c) => {
      const p = policyMap.get(c.policyId);
      return {
        ...c,
        policyTitle: p?.title ?? c.policyId,
        policySlug: p?.slug ?? c.policyId,
      };
    }),
    votes: votes.map((v) => {
      const p = policyMap.get(v.policyId);
      return {
        ...v,
        choice: v.choice === "approve" ? "approve" : "reject",
        policyTitle: p?.title ?? v.policyId,
        policySlug: p?.slug ?? v.policyId,
        policyStatus: p?.status ?? "open",
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
