import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { ALL_NATIONAL_PERMISSIONS, LEGACY_MODERATOR_PERMISSIONS } from "./rbac.ts";
import {
  GOVERNANCE_ROUTE_POLICY,
  GOVERNED_ROUTE_DIRECTORIES,
  authoriseGovernanceCommand,
  governanceRouteDeclaration,
} from "./route-policy.ts";
import { GOVERNANCE_COMMANDS } from "./governance-commands.ts";
import type { SessionUser } from "./types.ts";
import { POST as bindRoute } from "../pages/api/admin/ballots/bind.ts";
import { POST as recordResultRoute } from "../pages/api/admin/ballots/result.ts";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));

const ROUTE_HANDLER_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

function routeFilesIn(directory: string): Array<{
  route: string;
  methods: string[];
  source: string;
}> {
  const files = readdirSync(`${projectRoot}/${directory}`).filter((name) =>
    name.endsWith(".ts"),
  );
  return files.map((name) => {
    const source = readFileSync(`${projectRoot}/${directory}/${name}`, "utf8");
    const methods = ROUTE_HANDLER_METHODS.filter((method) =>
      new RegExp(`export const ${method}\\b`).test(source),
    );
    const route = `${directory.replace(/^src\/pages/, "")}/${name.replace(/\.ts$/, "")}`;
    return { route, methods, source };
  });
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
  it("declares every route in a governed directory", () => {
    for (const directory of GOVERNED_ROUTE_DIRECTORIES) {
      const files = routeFilesIn(directory);
      assert.ok(files.length > 0, `${directory} must contain at least one route`);
      for (const file of files) {
        assert.ok(
          file.methods.length > 0,
          `${file.route} exports no HTTP handler method`,
        );
        for (const method of file.methods) {
          const key = `${method} ${file.route}`;
          assert.ok(
            GOVERNANCE_ROUTE_POLICY.some((entry) => entry.route === key),
            `governance route '${key}' has no policy declaration`,
          );
        }
      }
    }
  });

  it("declares each policy against a real route file that runs the command layer", () => {
    for (const declaration of GOVERNANCE_ROUTE_POLICY) {
      const [method, path] = declaration.route.split(" ");
      const file = `${projectRoot}/src/pages${path}.ts`;
      assert.ok(existsSync(file), `${declaration.route} has no route file`);
      const source = readFileSync(file, "utf8");
      assert.match(
        source,
        new RegExp(`export const ${method}\\b`),
        `${declaration.route} does not export ${method}`,
      );
      assert.ok(
        source.includes(`"${declaration.route}"`),
        `${declaration.route} is not the route key the file uses`,
      );
      assert.ok(
        source.includes("runGovernanceRoute("),
        `${declaration.route} does not run the command layer`,
      );
      assert.ok(
        source.includes("authoriseGovernanceRoute("),
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
    for (const directory of GOVERNED_ROUTE_DIRECTORIES) {
      for (const file of routeFilesIn(directory)) {
        assert.ok(
          !file.source.includes('hasPermission("ballots.'),
          `${file.route} embeds an inline ballots permission literal`,
        );
        assert.ok(
          !/hasPermission\s*\(/.test(file.source),
          `${file.route} calls hasPermission directly instead of the policy table`,
        );
        assert.ok(
          !/requireApiPermission\s*\(/.test(file.source),
          `${file.route} calls requireApiPermission directly instead of the policy table`,
        );
        assert.ok(
          !/["']ballots\.(bind|record_result)["']/.test(file.source),
          `${file.route} embeds a permission key`,
        );
        assert.ok(
          !/\.isAdmin\b|\.isBranchAdmin\b/.test(file.source),
          `${file.route} re-implements the role gate instead of the policy table`,
        );
      }
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
});
