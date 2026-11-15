import type { Db } from "mongodb";
import { canManageBranchBallot } from "./auth.ts";
import { BallotBindingError } from "./ballot-binding.ts";
import { BallotDomainError } from "./ballots.ts";
import {
  governanceCommand,
  type CommandOutcome,
  type GovernanceCommand,
  type GovernanceCommandId,
  type GovernanceScope,
} from "./governance-commands.ts";
import { hasPermission, type PermissionKey } from "./rbac.ts";
import type { PlatformEnv, SessionUser } from "./types.ts";

/**
 * Central governance route policy.
 *
 * Every migrated governance route declares, in one table, the command it
 * invokes and the single permission it requires. Routes resolve this
 * declaration by route key and never embed a permission literal, so
 * enforcement and documentation cannot drift apart.
 *
 * Extraction is incremental (#53): only the ballot lifecycle is declared so
 * far. `GOVERNED_ROUTE_DIRECTORIES` names the directories whose route files
 * must have a declaration; the drift test fails if a governance route exists
 * without one. Add a directory here as its domain is migrated.
 */

export type GovernanceRouteKey =
  | "POST /api/admin/ballots/bind"
  | "POST /api/admin/ballots/result";

export interface GovernanceRouteDeclaration {
  route: GovernanceRouteKey;
  command: GovernanceCommandId;
  permission: PermissionKey;
}

export const GOVERNANCE_ROUTE_POLICY: readonly GovernanceRouteDeclaration[] = [
  {
    route: "POST /api/admin/ballots/bind",
    command: "ballot.bind",
    permission: "ballots.bind",
  },
  {
    route: "POST /api/admin/ballots/result",
    command: "ballot.record_result",
    permission: "ballots.record_result",
  },
];

/** Directories whose route files must declare their command and permission. */
export const GOVERNED_ROUTE_DIRECTORIES: readonly string[] = [
  "src/pages/api/admin/ballots",
];

const POLICY_BY_ROUTE = new Map<GovernanceRouteKey, GovernanceRouteDeclaration>(
  GOVERNANCE_ROUTE_POLICY.map((entry) => [entry.route, entry]),
);

export function governanceRouteDeclaration(
  route: GovernanceRouteKey,
): GovernanceRouteDeclaration {
  const declaration = POLICY_BY_ROUTE.get(route);
  if (!declaration)
    throw new Error(`Governance route '${route}' has no policy declaration.`);
  return declaration;
}

export interface AuthorisationDenial {
  status: 401 | 403;
  body: { error: string };
}

const SIGN_IN_REQUIRED = "Sign in required.";
const ADMINISTRATOR_ACCESS_REQUIRED = "Administrator access required.";

/**
 * Authorise `user` for a governance command.
 *
 * Without `scope` this is the coarse role gate the routes applied before
 * parsing: national administrator, branch administrator or permission holder.
 * With `scope` it also applies the resolved branch-scope rule — the permission
 * for that branch plus the ballot authority/jurisdiction match. Ordinary
 * moderators cannot satisfy either gate, and a branch grant never exceeds the
 * branch it was issued for.
 *
 * Returns `null` when authorised, otherwise the response to send.
 */
export function authoriseGovernanceCommand(
  user: SessionUser | null | undefined,
  commandId: GovernanceCommandId,
  scope?: GovernanceScope,
): AuthorisationDenial | null {
  if (!user) return { status: 401, body: { error: SIGN_IN_REQUIRED } };
  const permission = governanceCommand(commandId).requiredPermission;
  if (
    !user.isAdmin &&
    !user.isBranchAdmin &&
    !hasPermission(user, permission)
  )
    return { status: 403, body: { error: ADMINISTRATOR_ACCESS_REQUIRED } };
  if (!scope) return null;
  const command = governanceCommand(commandId);
  if (
    !hasPermission(user, permission, scope.branchScope) ||
    !canManageBranchBallot(user, scope.ballot)
  )
    return { status: 403, body: { error: command.scopeDeniedMessage } };
  return null;
}

export function authoriseGovernanceRoute(
  user: SessionUser | null | undefined,
  route: GovernanceRouteKey,
): AuthorisationDenial | null {
  return authoriseGovernanceCommand(
    user,
    governanceRouteDeclaration(route).command,
  );
}

export interface GovernanceRouteDependencies {
  env: PlatformEnv;
  user: SessionUser;
  /** Resolved after input validation so an invalid body still reports 400. */
  getDb: () => Promise<Db>;
}

/**
 * Run a declared governance route: validate input, load the governing record,
 * resolve its scope, authorise, then execute the command. Domain errors are
 * left to the route so they map to the same HTTP responses as before.
 */
export async function runGovernanceRoute(
  route: GovernanceRouteKey,
  dependencies: GovernanceRouteDependencies,
  body: Record<string, unknown>,
): Promise<CommandOutcome> {
  const declaration = governanceRouteDeclaration(route);
  const command = governanceCommand(declaration.command) as GovernanceCommand<
    unknown,
    unknown
  >;
  const denial = authoriseGovernanceCommand(dependencies.user, declaration.command);
  if (denial) return { status: denial.status, body: denial.body };
  const parsed = command.parse(body);
  if (!parsed.ok)
    return { status: parsed.status, body: { error: parsed.error } };
  const db = await dependencies.getDb();
  const lookup = await command.loadSubject(db, parsed.value);
  if (!lookup.ok) return { status: lookup.status, body: { error: lookup.error } };
  const scope = command.resolveScope(lookup.subject);
  const scopeDenial = authoriseGovernanceCommand(
    dependencies.user,
    declaration.command,
    scope,
  );
  if (scopeDenial) return { status: scopeDenial.status, body: scopeDenial.body };
  return command.execute({
    db,
    env: dependencies.env,
    actor: { memberId: dependencies.user.memberId },
    input: parsed.value,
    subject: lookup.subject,
    scope,
  });
}

/**
 * Map a thrown error to the response the route returned before this refactor.
 * Domain errors keep their own status and message; anything else is a 400.
 */
export function governanceRouteError(
  route: GovernanceRouteKey,
  error: unknown,
): CommandOutcome {
  if (error instanceof BallotBindingError || error instanceof BallotDomainError)
    return { status: error.status, body: { error: error.message } };
  const command = governanceCommand(governanceRouteDeclaration(route).command);
  return {
    status: 400,
    body: {
      error: error instanceof Error ? error.message : command.fallbackMessage,
    },
  };
}
