export interface RevisionLabelInput {
  revisionId: string;
  createdAt?: Date | string | null;
  ordinal?: number;
}

const formatDate = (value: Date | string) => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Australia/Melbourne",
  });
};

/**
 * Member-facing revision wording. Exact immutable identifiers stay available
 * in the revision history and administrative/audit views.
 */
export function revisionDisplayLabel({
  revisionId,
  createdAt,
  ordinal,
}: RevisionLabelInput): string {
  const date = createdAt ? formatDate(createdAt) : "";
  const suffix = date ? ` · ${date}` : "";
  if (revisionId.startsWith("legacy-")) return `Original recorded wording${suffix}`;
  if (ordinal && ordinal > 0) return `Wording revision ${ordinal}${suffix}`;
  return `Recorded wording revision${suffix}`;
}

/** The exact identifier is retained for audit views and title attributes. */
export function revisionReferenceLabel(revisionId: string): string {
  return revisionId;
}
