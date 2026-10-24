import { adminPageDenial } from '../../../lib/platform/admin-access.ts';
import { getDatabase } from '../../../lib/platform/database.ts';
import { resolveIdentity } from '../../../lib/platform/auth.ts';
import { discussionAudience } from '../../../lib/platform/discussion-access.ts';
import { json, platformEnv } from '../../../lib/platform/http.ts';
import type { RuntimeLocals } from '../../../lib/platform/types.ts';

export const prerender = false;

/** A read-only view: catalogue/listBallots helpers also finalise expired ballots. */
export async function GET({ request, locals }: { request: Request; locals: RuntimeLocals }): Promise<Response> {
  const env = platformEnv(locals);
  const denial = await adminPageDenial(request, env);
  if (denial) return json({ error: denial.status === 401 ? 'Sign in to access administration.' : denial.status === 403 ? 'Verified operator access is required.' : 'Administration is temporarily unavailable.' }, denial.status);
  try {
    const { identity } = await resolveIdentity(request, env);
    const db = await getDatabase(env);
    const now = new Date();
    const [pending, drafts, expired, incomplete] = await Promise.all([
      db.collection('consultation_submissions').find({ status: 'pending', ...discussionAudience(identity!) }, {
        projection: { _id: 0, submissionId: 1, policyId: 1, roundId: 1, title: 1, kind: 1, createdAt: 1 },
      }).sort({ createdAt: 1 }).limit(21).toArray(),
      db.collection('ballots').find({ status: 'draft' }, { projection: { _id: 0, ballotId: 1, title: 1, proposalId: 1 } }).sort({ opensAt: 1 }).limit(21).toArray(),
      db.collection('ballots').find({ status: 'open', closesAt: { $lte: now } }, { projection: { _id: 0, ballotId: 1, title: 1, proposalId: 1 } }).sort({ closesAt: 1 }).limit(21).toArray(),
      db.collection('ballots').find({ status: 'closed', finalizedAt: { $exists: false } }, { projection: { _id: 0, ballotId: 1, title: 1, proposalId: 1 } }).sort({ closedAt: 1 }).limit(21).toArray(),
    ]);
    const page = (items: typeof drafts) => ({ items: items.slice(0, 20), hasMore: items.length > 20 });
    return json({ pending: page(pending), drafts: page(drafts), expired: page(expired), incomplete: page(incomplete) });
  } catch {
    return json({ error: 'Work items are temporarily unavailable. Please retry.' }, 503);
  }
}
