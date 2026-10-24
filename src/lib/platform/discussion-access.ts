import type { Db } from 'mongodb';
import type { PlatformEnv, PlatformIdentity } from './types.ts';
import { membershipEligibility } from './membership.ts';

export async function canReadDiscussion(db: Db, identity: PlatformIdentity | null, env: PlatformEnv): Promise<boolean> {
  if (!identity) return false;
  if (identity.source === 'synthetic') return env.APP_MODE === 'preview';
  if (env.APP_MODE === 'preview' || identity.source !== 'engage') return false;
  return (await membershipEligibility(db, identity.memberId)).eligible;
}

export async function requireDiscussionAccess(db: Db, identity: PlatformIdentity | null, env: PlatformEnv): Promise<void> {
  if (!await canReadDiscussion(db, identity, env)) throw new Error('Verified membership is required to access member discussion.');
}

export function discussionAudience(identity: PlatformIdentity) {
  return { identitySource: identity.source };
}
