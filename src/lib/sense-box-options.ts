export const SENSE_TOPICS = {
  housing: 'Housing & cost of living',
  health: 'Health & care',
  environment: 'Climate & environment',
  transport: 'Transport & infrastructure',
  education: 'Education & jobs',
  democracy: 'Democracy & public services',
  community: 'Community & inclusion',
  other: 'Something else',
} as const;
export const SENSE_STATUSES = { new:'New', reviewed:'Reviewed', developing:'Developing a proposal', archived:'Archived' } as const;
export type SenseTopic = keyof typeof SENSE_TOPICS;
export type SenseStatus = keyof typeof SENSE_STATUSES;
export type SenseVisibility = 'private' | 'published';
export interface SenseItem {
  submissionId: string;
  branchId: string;
  title: string;
  detail: string;
  locality: string;
  topic: SenseTopic;
  status: SenseStatus;
  createdAt: string;
  version: number;
  visibility: SenseVisibility;
  publishedAt?: string;
  linkedProposalId?: string;
  commentCount?: number;
  /** True only when the contributor consented to review-then-publication. */
  publicationConsent: boolean;
}
export interface SenseInbox {
  items: SenseItem[];
  total: number;
  page: number;
  topics: Record<string, number>;
}
export interface SenseComment {
  commentId: string;
  authorName: string;
  body: string;
  visibility: 'public' | 'internal';
  createdAt: string;
  /** Preformatted on the server so hydration is stable. */
  createdAtLabel: string;
  deleted: boolean;
  isMine: boolean;
}
export interface SenseLinkedProposal {
  slug: string;
  title: string;
  stage: string;
}
export interface SensePublicItem {
  submissionId: string;
  branchId: string;
  title: string;
  detail: string;
  locality: string;
  topic: SenseTopic;
  publishedAt: string;
  commentCount: number;
  linkedProposal?: SenseLinkedProposal;
}
export interface SenseSubmissionDetail extends SenseItem {
  publishedAt?: string;
  linkedProposal?: SenseLinkedProposal & { proposalId?: string };
  comments: SenseComment[];
}
export type SenseReceiptStage = 'received' | 'reviewing' | 'published' | 'closed';
export interface SenseReceipt {
  submissionId: string;
  branchId: string;
  title: string;
  topic: SenseTopic;
  createdAt: string;
  stage: SenseReceiptStage;
  publicationConsent: boolean;
  publishedAt?: string;
}
