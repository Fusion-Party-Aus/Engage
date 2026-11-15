import type { Db } from "mongodb";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
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
  /**
   * Mirrors the command's `requiredPermission` so the table is readable on its
   * own. The route enforces the command's value; a test fails if the two drift.
   */
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

/** Directories scanned recursively for route files that must declare their command and permission. */
export const GOVERNED_ROUTE_DIRECTORIES: readonly string[] = [
  "src/pages/api/admin/ballots",
];

export interface DiscoveredGovernanceRoute {
  /** Absolute path of the route module. */
  file: string;
  source: string;
  /** Export names that are HTTP handlers, e.g. `["POST"]`. */
  methods: string[];
  /** Route keys derived from the file location, e.g. `["POST /api/.../bind"]`. */
  routes: string[];
}

const HTTP_HANDLER_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
  "HEAD",
  "ALL",
] as const;

const ROUTE_FILE_EXTENSIONS = [".ts", ".js", ".mjs"] as const;

function routeFilesRecursively(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...routeFilesRecursively(path));
    } else if (
      entry.isFile() &&
      ROUTE_FILE_EXTENSIONS.some((extension) => entry.name.endsWith(extension))
    ) {
      files.push(path);
    }
  }
  return files.sort();
}

/**
 * Handler exports in any supported form: `export const POST`, `export function
 * GET`, `export async function POST` and `export { handler as POST }`.
 */
function exportedHandlerMethods(source: string): string[] {
  const exported = new Set<string>();
  const addIfHandler = (name: string) => {
    if ((HTTP_HANDLER_METHODS as readonly string[]).includes(name))
      exported.add(name);
  };
  for (const match of source.matchAll(
    /export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b/g,
  ))
    addIfHandler(match[1]);
  for (const match of source.matchAll(
    /export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\b/g,
  ))
    addIfHandler(match[1]);
  for (const match of source.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const clause of match[1].split(",")) {
      const [local, alias] = clause.trim().split(/\s+as\s+/);
      addIfHandler((alias ?? local).trim());
    }
  }
  return HTTP_HANDLER_METHODS.filter((method) => exported.has(method));
}

/**
 * Discover every route module under `roots` and derive its route keys from the
 * path relative to `apiRoot` (the `src/pages/api` directory). Recursive and
 * extension-agnostic so a nested or JavaScript route cannot escape the drift
 * check. Pure: callers pass absolute paths, so tests can point it at a temporary
 * directory.
 */
export function discoverGovernedRoutes(
  apiRoot: string,
  roots: readonly string[],
): DiscoveredGovernanceRoute[] {
  const discovered: DiscoveredGovernanceRoute[] = [];
  for (const root of roots) {
    for (const file of routeFilesRecursively(root)) {
      const source = readFileSync(file, "utf8");
      const methods = exportedHandlerMethods(source);
      if (!methods.length) continue;
      const routePath =
        "/api/" +
        relative(apiRoot, file)
          .split(sep)
          .join("/")
          .replace(/\.(ts|js|mjs)$/, "")
          .replace(/\/index$/, "");
      discovered.push({
        file,
        source,
        methods,
        routes: methods.map((method) => `${method} ${routePath}`),
      });
    }
  }
  return discovered;
}

/** Route keys that exist under a governed root but have no declaration. */
export function undeclaredGovernanceRoutes(
  discovered: readonly DiscoveredGovernanceRoute[],
  declarations: readonly GovernanceRouteDeclaration[] = GOVERNANCE_ROUTE_POLICY,
): string[] {
  const declared = new Set<string>(
    declarations.map((entry) => entry.route),
  );
  return discovered
    .flatMap((entry) => entry.routes)
    .filter((route) => !declared.has(route))
    .sort();
}

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

/**
 * The coarse role gate only: national administrator, branch administrator or
 * permission holder. It deliberately does not check branch scope — the route
 * applies it before parsing to preserve the published 403 ordering, and
 * `runGovernanceRoute` applies the resolved scope gate before any write.
 */
export function authoriseGovernanceRouteRole(
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
  // The route already applied this coarse gate before reading the body. It is
  // repeated deliberately so a caller that forgets the route-level gate still
  // cannot reach a command without authorisation.
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
 * The one domain error class each route's handler caught before the command
 * layer existed. Everything else stays on the generic 400 path, exactly as it
 * did: a `BallotDomainError` escaping the bind route is not an improvement
 * opportunity, it is a status code that must not change.
 */
const ROUTE_DOMAIN_ERRORS: Record<
  GovernanceRouteKey,
  readonly (typeof BallotBindingError | typeof BallotDomainError)[]
> = {
  "POST /api/admin/ballots/bind": [BallotBindingError],
  "POST /api/admin/ballots/result": [BallotDomainError],
};

/**
 * Map a thrown error to the response the route returned before this refactor.
 * Only the route's own domain error keeps its status and message; anything else
 * is a 400, as before.
 */
export function governanceRouteError(
  route: GovernanceRouteKey,
  error: unknown,
): CommandOutcome {
  if (
    error instanceof Error &&
    ROUTE_DOMAIN_ERRORS[route].some(
      (domainError) => error instanceof domainError,
    )
  )
    return {
      status: (error as Error & { status: number }).status,
      body: { error: error.message },
    };
  const command = governanceCommand(governanceRouteDeclaration(route).command);
  return {
    status: 400,
    body: {
      error: error instanceof Error ? error.message : command.fallbackMessage,
    },
  };
}
