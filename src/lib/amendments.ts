import { createHash, randomUUID } from "node:crypto";
import type { Db } from "mongodb";
import type { AmendmentSuggestion } from "./amendment-suggestions.ts";

export async function createAmendmentRevision(
  db: Db,
  amendmentId: string,
  changes: Record<string, unknown>,
  authorId: string,
  parentRevisionId: string | null = null,
  suggestions?: AmendmentSuggestion[],
) {
  const revisionId = randomUUID();
  const snapshot = structuredClone(changes);
  const contentHash = createHash("sha256")
    .update(JSON.stringify(snapshot))
    .digest("hex");
  await db
    .collection("amendment_revisions")
    .insertOne({
      revisionId,
      amendmentId,
      parentRevisionId,
      authorId,
      createdAt: new Date(),
      snapshot,
      contentHash,
      provenance: "member-proposed",
      // Suggestions are the evidence behind the whole-field snapshot. They are
      // immutable with the revision so a later rebase can be compared.
      ...(suggestions?.length ? { suggestions: structuredClone(suggestions) } : {}),
    });
  return revisionId;
}
