import { hasPermissionAnywhere, type PermissionKey } from "./rbac.ts";
import type { SessionUser } from "./types.ts";

/**
 * The permissions a responsibility-queue source depends on.
 *
 * Kept separate from the queue read model so layouts can decide whether to
 * offer the navigation entry without importing the source queries.
 */
export const RESPONSIBILITY_SOURCE_PERMISSIONS: readonly PermissionKey[] = [
  "ballots.bind",
  "ballots.record_result",
  "amendments.resolve",
  "amendments.manage_ballot",
  "amendments.apply",
  "members.verify",
  "policies.publish",
];

export function viewerHasResponsibility(
  viewer: SessionUser | null | undefined,
): boolean {
  return Boolean(
    viewer &&
      RESPONSIBILITY_SOURCE_PERMISSIONS.some((permission) =>
        hasPermissionAnywhere(viewer, permission),
      ),
  );
}
