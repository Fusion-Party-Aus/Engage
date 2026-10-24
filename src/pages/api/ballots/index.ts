import { ensureIndexes, getDatabase } from "../../../lib/platform/database";
import { listBallots } from "../../../lib/platform/ballots";
import { json, platformEnv } from "../../../lib/platform/http";
import type { RuntimeLocals } from "../../../lib/platform/types";

export const prerender = false;

export async function GET({ locals }: { locals: RuntimeLocals }): Promise<Response> {
  try {
    const db = await getDatabase(platformEnv(locals));
    await ensureIndexes(db);
    const ballots = await listBallots(db);
    return json({ ballots, syntheticOnly: platformEnv(locals).APP_MODE === "preview" });
  } catch {
    return json({ error: "Ballots are temporarily unavailable." }, 503);
  }
}
