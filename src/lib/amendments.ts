import { createHash, randomUUID } from "node:crypto";
import type { Db } from "mongodb";

export async function createAmendmentRevision(
  db: Db,
  amendmentId: string,
  changes: Record<string, unknown>,
  authorId: string,
  parentRevisionId: string | null = null,
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
    });
  return revisionId;
}
