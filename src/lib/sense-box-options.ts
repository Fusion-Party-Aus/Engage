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
export const SENSE_STATUSES = { new:'New', reviewed:'Reviewed', developing:'Exploring for a proposal', archived:'Archived' } as const;
export type SenseTopic = keyof typeof SENSE_TOPICS;
export type SenseStatus = keyof typeof SENSE_STATUSES;
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
}
export interface SenseInbox {
  items: SenseItem[];
  total: number;
  page: number;
  topics: Record<string, number>;
}
