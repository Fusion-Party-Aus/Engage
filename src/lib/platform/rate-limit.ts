import type { Db, Document } from "mongodb";

interface RateLimitDocument extends Document {
  scope: string;
  subjectId: string;
  window: number;
  count: number;
  expiresAt: Date;
}

/** Database-backed fixed-window limit keyed by authenticated platform identity, never by a raw email address or IP. */
export async function consumeRateLimit(db: Db, scope: string, subjectId: string, maxRequests: number, windowMs: number, now = new Date()): Promise<boolean> {
  const window = Math.floor(now.getTime() / windowMs);
  const key = { scope, subjectId, window };
  const expiresAt = new Date((window + 2) * windowMs);
  const limits = db.collection<RateLimitDocument>("mutation_rate_limits");
  let result;
  try {
    result = await limits.findOneAndUpdate(key, {
      $inc: { count: 1 },
      $setOnInsert: { expiresAt },
    }, { upsert: true, returnDocument: "after" });
  } catch (error) {
    if (!error || typeof error !== "object" || (error as { code?: number }).code !== 11000) throw error;
    await limits.updateOne(key, { $inc: { count: 1 } });
    result = await limits.findOne(key);
  }
  return (result?.count ?? maxRequests + 1) <= maxRequests;
}
