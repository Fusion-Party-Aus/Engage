import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { ALL_NATIONAL_PERMISSIONS, LEGACY_MODERATOR_PERMISSIONS } from "./rbac.ts";
import {
  GOVERNANCE_ROUTE_POLICY,
  GOVERNED_ROUTE_DIRECTORIES,
  authoriseGovernanceCommand,
  discoverGovernedRoutes,
  governanceRouteDeclaration,
  undeclaredGovernanceRoutes,
  type GovernanceRouteDeclaration,
} from "./route-policy.ts";
import { GOVERNANCE_COMMANDS } from "./governance-commands.ts";
import type { SessionUser } from "./types.ts";
import { POST as bindRoute } from "../pages/api/admin/ballots/bind.ts";
import { POST as recordResultRoute } from "../pages/api/admin/ballots/result.ts";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const apiRoot = `${projectRoot}/src/pages/api`;
const governedRoots = GOVERNED_ROUTE_DIRECTORIES.map(
  (directory) => `${projectRoot}/${directory}`,
);
const discovered = discoverGovernedRoutes(apiRoot, governedRoots);

interface RouteFixture {
  apiRoot: string;
  root: string;
  cleanup: () => void;
}

/** Build a temporary `src/pages/api` tree; never touches the repository. */
function routeFixture(files: Record<string, string>): RouteFixture {
  const base = mkdtempSync(join(tmpdir(), "engage-governed-routes-"));
  const fixtureApiRoot = join(base, "api");
  for (const [relativePath, source] of Object.entries(files)) {
    const file = join(fixtureApiRoot, relativePath);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, source);
  }
  return {
    apiRoot: fixtureApiRoot,
    root: join(fixtureApiRoot, "admin", "ballots"),
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

const baseUser: SessionUser = {
  memberId: "member-1",
  name: "Member One",
  email: "member@example.test",
  role: "member",
  roles: ["member"],
  status: "verified",
  canParticipate: true,
  isStaff: false,
  isAdmin: false,
  isBranchAdmin: false,
  branchAdminIds: [],
  permissions: { national: [], branches: {}, grants: [] },
};

const nationalAdmin: SessionUser = {
  ...baseUser,
  memberId: "admin-1",
  role: "administrator",
  roles: ["member", "administrator"],
  isStaff: true,
  isAdmin: true,
  permissions: {
    national: [...ALL_NATIONAL_PERMISSIONS],
    branches: {},
    grants: [],
  },
};

const moderator: SessionUser = {
  ...baseUser,
  memberId: "moderator-1",
  role: "moderator",
  roles: ["member", "moderator"],
  isStaff: true,
  permissions: {
    national: [...LEGACY_MODERATOR_PERMISSIONS],
    branches: {},
    grants: [],
  },
};

const branchAdmin = (branchId: string, permissions: ("ballots.bind" | "ballots.record_result")[]): SessionUser => ({
  ...baseUser,
  memberId: `branch-admin-${branchId}`,
  isBranchAdmin: true,
  branchAdminIds: [branchId],
  permissions: { national: [], branches: { [branchId]: permissions }, grants: [] },
});

const nationalPermissionHolder = (
  permission: "ballots.bind" | "ballots.record_result",
): SessionUser => ({
  ...baseUser,
  memberId: `holder-${permission}`,
  permissions: { national: [permission], branches: {}, grants: [] },
});

const matchingScope = (branchId: string) => ({
  branchScope: branchId,
  ballot: {
    governanceAuthorityBranchId: branchId,
    jurisdictionBranchId: branchId,
  },
});

const otherScope = (branchId: string) => ({
  branchScope: branchId,
  ballot: {
    governanceAuthorityBranchId: "branch-other",
    jurisdictionBranchId: "branch-other",
  },
});

describe("governance route policy declarations", () => {
  it("discovers every route under a governed directory and declares it", () => {
    assert.ok(discovered.length > 0, "the governed directories contain routes");
    for (const entry of discovered)
      assert.ok(entry.methods.length > 0, `${entry.file} exports no handler`);
    assert.deepEqual(
      undeclaredGovernanceRoutes(discovered),
      [],
      "every discovered governance route must be declared",
    );
    for (const declaration of GOVERNANCE_ROUTE_POLICY) {
      assert.ok(
        discovered.some((entry) => entry.routes.includes(declaration.route)),
        `${declaration.route} does not correspond to a discovered route file`,
      );
    }
  });

  it("declares each policy against a real route file that runs the command layer", () => {
    for (const declaration of GOVERNANCE_ROUTE_POLICY) {
      const [method] = declaration.route.split(" ");
      const entry = discovered.find((candidate) =>
        candidate.routes.includes(declaration.route),
      );
      assert.ok(entry, `${declaration.route} has no route file`);
      assert.match(
        entry.source,
        new RegExp(`export const ${method}\\b`),
        `${declaration.route} does not export ${method}`,
      );
      assert.ok(
        entry.source.includes(`"${declaration.route}"`),
        `${declaration.route} is not the route key the file uses`,
      );
      assert.ok(
        entry.source.includes("runGovernanceRoute("),
        `${declaration.route} does not run the command layer`,
      );
      assert.ok(
        entry.source.includes("authoriseGovernanceRouteRole("),
        `${declaration.route} does not authorise through the policy table`,
      );
    }
  });

  it("declares the permission the command enforces", () => {
    for (const declaration of GOVERNANCE_ROUTE_POLICY) {
      assert.equal(
        declaration.permission,
        GOVERNANCE_COMMANDS[declaration.command].requiredPermission,
        `${declaration.route} declares '${declaration.permission}' but the command requires '${GOVERNANCE_COMMANDS[declaration.command].requiredPermission}'`,
      );
      assert.equal(
        governanceRouteDeclaration(declaration.route).command,
        declaration.command,
      );
    }
  });

  it("keeps permission checks and permission literals out of governed route files", () => {
    for (const entry of discovered) {
      assert.ok(
        !entry.source.includes('hasPermission("ballots.'),
        `${entry.file} embeds an inline ballots permission literal`,
      );
      assert.ok(
        !/hasPermission\s*\(/.test(entry.source),
        `${entry.file} calls hasPermission directly instead of the policy table`,
      );
      assert.ok(
        !/requireApiPermission\s*\(/.test(entry.source),
        `${entry.file} calls requireApiPermission directly instead of the policy table`,
      );
      assert.ok(
        !/["']ballots\.(bind|record_result)["']/.test(entry.source),
        `${entry.file} embeds a permission key`,
      );
      assert.ok(
        !/\.isAdmin\b|\.isBranchAdmin\b/.test(entry.source),
        `${entry.file} re-implements the role gate instead of the policy table`,
      );
    }
  });
});

describe("governed route discovery", () => {
  it("finds nested, index and JavaScript routes with every handler export form", () => {
    const fixture = routeFixture({
      "admin/ballots/bind.ts":
        'import type { APIRoute } from "astro";\nexport const POST: APIRoute = async () => new Response();\n',
      "admin/ballots/[id]/certify.ts":
        'import { hasPermission } from "../../../../lib/rbac.ts";\nexport async function POST() { hasPermission(null, "ballots.bind"); }\n',
      "admin/ballots/legacy.js":
        "export function GET() { return new Response(); }\n",
      "admin/ballots/reexport.mjs":
        "const patch = () => new Response();\nexport { patch as PATCH };\n",
      "admin/ballots/index.ts":
        "export const GET = () => new Response();\nexport const prerender = false;\n",
      "admin/ballots/multi.ts":
        "export const prerender = false, POST = async () => new Response();\n",
      "admin/ballots/helper.ts":
        "export const helper = () => 1;\n",
    });
    try {
      const routes = discoverGovernedRoutes(fixture.apiRoot, [fixture.root]);
      const keys = routes.flatMap((entry) => entry.routes);
      assert.ok(
        keys.includes("POST /api/admin/ballots/bind"),
        "const handler discovered",
      );
      assert.ok(
        keys.includes("POST /api/admin/ballots/[id]/certify"),
        "nested route discovered",
      );
      assert.ok(
        keys.includes("GET /api/admin/ballots/legacy"),
        "JavaScript route discovered",
      );
      assert.ok(
        keys.includes("PATCH /api/admin/ballots/reexport"),
        "export { handler as METHOD } discovered",
      );
      assert.ok(
        keys.includes("GET /api/admin/ballots"),
        "index route key omits /index",
      );
      assert.ok(
        keys.includes("POST /api/admin/ballots/multi"),
        "multi-binding export handler discovered after non-handler binding",
      );
      assert.ok(
        undeclaredGovernanceRoutes(routes).includes("POST /api/admin/ballots/multi"),
        "undeclaredGovernanceRoutes reports multi-binding POST route",
      );
      assert.ok(
        !keys.some((key) => key.includes("helper")),
        "a module with no handler export is not a route",
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("fails closed for a nested or JavaScript route with no declaration", () => {
    const fixture = routeFixture({
      "admin/ballots/bind.ts": "export const POST = () => new Response();\n",
      "admin/ballots/[id]/certify.ts":
        'import { hasPermission } from "rbac";\nexport const POST = () => hasPermission(null, "ballots.bind");\n',
      "admin/ballots/legacy.js": "export const DELETE = () => new Response();\n",
    });
    try {
      const routes = discoverGovernedRoutes(fixture.apiRoot, [fixture.root]);
      const declarations: GovernanceRouteDeclaration[] = [
        {
          route: "POST /api/admin/ballots/bind",
          command: "ballot.bind",
          permission: "ballots.bind",
        },
      ];
      assert.deepEqual(undeclaredGovernanceRoutes(routes, declarations), [
        "DELETE /api/admin/ballots/legacy",
        "POST /api/admin/ballots/[id]/certify",
      ]);
    } finally {
      fixture.cleanup();
    }
  });
});

describe("governance command authorisation", () => {
  const commandIds = ["ballot.bind", "ballot.record_result"] as const;

  it("rejects an unauthenticated caller with 401 for both commands", () => {
    for (const commandId of commandIds) {
      const denial = authoriseGovernanceCommand(null, commandId);
      assert.equal(denial?.status, 401);
      assert.equal(denial?.body.error, "Sign in required.");
    }
  });

  it("allows a national administrator for both commands, including another branch's ballot", () => {
    for (const commandId of commandIds) {
      assert.equal(authoriseGovernanceCommand(nationalAdmin, commandId), null);
      assert.equal(
        authoriseGovernanceCommand(nationalAdmin, commandId, otherScope("branch-vic")),
        null,
      );
    }
  });

  it("allows a branch administrator with matching authority and jurisdiction", () => {
    const bindAdmin = branchAdmin("branch-vic", ["ballots.bind"]);
    assert.equal(
      authoriseGovernanceCommand(bindAdmin, "ballot.bind", matchingScope("branch-vic")),
      null,
    );
    const resultAdmin = branchAdmin("branch-vic", ["ballots.record_result"]);
    assert.equal(
      authoriseGovernanceCommand(
        resultAdmin,
        "ballot.record_result",
        matchingScope("branch-vic"),
      ),
      null,
    );
  });

  it("denies a branch administrator whose branch does not match the ballot authority", () => {
    const bindAdmin = branchAdmin("branch-vic", ["ballots.bind"]);
    let denial = authoriseGovernanceCommand(
      bindAdmin,
      "ballot.bind",
      matchingScope("branch-nsw"),
    );
    assert.equal(denial?.status, 403);
    assert.equal(denial?.body.error, "You are not authorised to review this ballot.");
    denial = authoriseGovernanceCommand(
      bindAdmin,
      "ballot.bind",
      otherScope("branch-vic"),
    );
    assert.equal(denial?.status, 403);

    const resultAdmin = branchAdmin("branch-vic", ["ballots.record_result"]);
    denial = authoriseGovernanceCommand(
      resultAdmin,
      "ballot.record_result",
      matchingScope("branch-nsw"),
    );
    assert.equal(denial?.status, 403);
    assert.match(String(denial?.body.error), /not authorised to record an outcome/);
  });

  it("allows a national permission holder for both commands", () => {
    assert.equal(
      authoriseGovernanceCommand(
        nationalPermissionHolder("ballots.bind"),
        "ballot.bind",
        matchingScope("branch-vic"),
      ),
      null,
    );
    assert.equal(
      authoriseGovernanceCommand(
        nationalPermissionHolder("ballots.record_result"),
        "ballot.record_result",
        matchingScope("branch-vic"),
      ),
      null,
    );
  });

  it("allows a branch-delegated officer without the branch administrator role", () => {
    const officer: SessionUser = {
      ...baseUser,
      memberId: "delegated-vic",
      permissions: {
        national: [],
        branches: { "branch-vic": ["ballots.bind"] },
        grants: [],
      },
    };
    assert.equal(
      authoriseGovernanceCommand(officer, "ballot.bind", matchingScope("branch-vic")),
      null,
    );
    // A grant for one act never travels to another.
    const denial = authoriseGovernanceCommand(
      officer,
      "ballot.record_result",
      matchingScope("branch-vic"),
    );
    assert.equal(denial?.status, 403);
    assert.equal(denial?.body.error, "Administrator access required.");
  });

  it("explains a branch authority and jurisdiction mismatch", () => {
    const officer: SessionUser = {
      ...baseUser,
      memberId: "delegated-vic",
      permissions: {
        national: [],
        branches: { "branch-vic": ["ballots.bind"] },
        grants: [],
      },
    };
    const denial = authoriseGovernanceCommand(officer, "ballot.bind", {
      branchScope: "branch-vic",
      ballot: {
        governanceAuthorityBranchId: "branch-vic",
        jurisdictionBranchId: "branch-nsw",
      },
    });
    assert.equal(denial?.status, 403);
    assert.equal(denial?.body.error, "You are not authorised to review this ballot.");
  });

  it("does not let a national permission for one command authorise the other", () => {
    const denial = authoriseGovernanceCommand(
      nationalPermissionHolder("ballots.bind"),
      "ballot.record_result",
    );
    assert.equal(denial?.status, 403);
    assert.equal(denial?.body.error, "Administrator access required.");
  });

  it("denies an ordinary moderator for both commands", () => {
    for (const commandId of commandIds) {
      const denial = authoriseGovernanceCommand(
        moderator,
        commandId,
        matchingScope("branch-vic"),
      );
      assert.equal(denial?.status, 403);
      assert.equal(denial?.body.error, "Administrator access required.");
    }
  });

  it("does not let amendment ballot authority confer proposal ballot authority", () => {
    const branchAdminWithAmendments: SessionUser = {
      ...baseUser,
      memberId: "amendment-officer",
      isBranchAdmin: true,
      branchAdminIds: ["branch-vic"],
      permissions: {
        national: [],
        branches: { "branch-vic": ["amendments.manage_ballot"] },
        grants: [],
      },
    };
    const denial = authoriseGovernanceCommand(
      branchAdminWithAmendments,
      "ballot.record_result",
      matchingScope("branch-vic"),
    );
    assert.equal(denial?.status, 403);
  });
});

describe("governance route authentication gate", () => {
  const call = (
    handler: typeof bindRoute,
    path: string,
    cookie?: string,
  ) =>
    handler({
      request: new Request(`http://localhost${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(cookie ? { Cookie: cookie } : {}),
        },
        body: JSON.stringify({}),
      }),
      locals: { runtime: { env: { APP_MODE: "test" } } },
    } as never);

  const callWithRawBody = (
    handler: typeof bindRoute,
    path: string,
    body: string,
    cookie: string,
  ) =>
    handler({
      request: new Request(`http://localhost${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body,
      }),
      locals: { runtime: { env: { APP_MODE: "test" } } },
    } as never);

  it("returns 401 for both ballot routes without a session", async () => {
    let response = await call(bindRoute, "/api/admin/ballots/bind");
    assert.equal(response.status, 401);
    assert.equal(
      ((await response.json()) as { error: string }).error,
      "Sign in required.",
    );
    response = await call(recordResultRoute, "/api/admin/ballots/result");
    assert.equal(response.status, 401);
  });

  it("returns 403 for a signed-in ordinary member on both ballot routes", async () => {
    let response = await call(
      bindRoute,
      "/api/admin/ballots/bind",
      "engage_dev_user=member",
    );
    assert.equal(response.status, 403);
    assert.equal(
      ((await response.json()) as { error: string }).error,
      "Administrator access required.",
    );
    response = await call(
      recordResultRoute,
      "/api/admin/ballots/result",
      "engage_dev_user=member",
    );
    assert.equal(response.status, 403);
  });

  it("returns 403, not 400, when an unauthorised caller sends a malformed body", async () => {
    for (const [handler, path] of [
      [bindRoute, "/api/admin/ballots/bind"],
      [recordResultRoute, "/api/admin/ballots/result"],
    ] as const) {
      const response = await callWithRawBody(
        handler,
        path,
        "{",
        "engage_dev_user=member",
      );
      assert.equal(response.status, 403);
      assert.equal(
        ((await response.json()) as { error: string }).error,
        "Administrator access required.",
      );
    }
  });
});
