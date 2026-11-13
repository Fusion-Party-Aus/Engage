import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { Db } from "mongodb";
import { createMemoryDb } from "./db.ts";
import {
  GEOGRAPHIC_PROPOSAL_SCOPES,
  PROPOSAL_SCOPE_KEYS,
  defaultProposalScopeKey,
  describeProposalScope,
  geographicScopeForBranch,
  listAuthorisedProposalScopes,
  normalizeProposalScopeKey,
  storedProposalScopeKey,
} from "./proposal-scope.ts";
import { saveProposal } from "./store.ts";
import type { SessionUser } from "./types.ts";

const root = new URL("../../", import.meta.url);
const read = (path: string) => readFile(new URL(path, root), "utf8");

const admin: SessionUser = {
  memberId: "scope-admin",
  name: "Scope Admin",
  email: "scope-admin@example.org",
  role: "administrator",
  status: "verified",
  canParticipate: true,
  isStaff: true,
  isAdmin: true,
};

function member(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    memberId: "scope-member",
    name: "Scope Member",
    email: "scope-member@example.org",
    role: "member",
    status: "verified",
    canParticipate: true,
    isStaff: false,
    isAdmin: false,
    ...overrides,
  };
}

function branchAdmin(branchId: string, overrides: Partial<SessionUser> = {}) {
  return member({
    memberId: `scope-admin-${branchId}`,
    isBranchAdmin: true,
    branchAdminIds: [branchId],
    verifiedBranchIds: [branchId],
    activeBranchIds: [branchId],
    ...overrides,
  });
}

async function seededDb(): Promise<Db> {
  const db = createMemoryDb();
  for (const branch of [
    {
      branchId: "branch-nat",
      name: "Fusion National",
      kind: "national",
      recognised: true,
    },
    {
      branchId: "branch-vic",
      name: "Fusion Victoria",
      kind: "state",
      parentBranchId: "branch-nat",
      recognised: true,
    },
    {
      branchId: "branch-nsw",
      name: "Fusion New South Wales",
      kind: "state",
      parentBranchId: "branch-nat",
      recognised: true,
    },
    {
      branchId: "branch-melbourne",
      name: "Fusion Melbourne",
      kind: "constituent",
      parentBranchId: "branch-vic",
      recognised: true,
    },
  ]) {
    await db.collection("branches").insertOne(branch as any);
  }
  return db;
}

function proposalSeed(overrides: Record<string, unknown> = {}) {
  return {
    title: "Scope test proposal",
    space: "Governance",
    summary: "A summary that is long enough for validation.",
    ...overrides,
  };
}

describe("proposal scope: canonical geography and branch identity", () => {
  it("defines National once and names every state and territory consistently", () => {
    assert.equal(GEOGRAPHIC_PROPOSAL_SCOPES.length, 9);
    assert.equal(new Set(PROPOSAL_SCOPE_KEYS).size, 9);
    assert.deepEqual(
      GEOGRAPHIC_PROPOSAL_SCOPES.map((scope) => scope.label),
      [
        "National",
        "New South Wales",
        "Victoria",
        "Queensland",
        "Western Australia",
        "South Australia",
        "Tasmania",
        "Australian Capital Territory",
        "Northern Territory",
      ],
    );
    assert.equal(
      GEOGRAPHIC_PROPOSAL_SCOPES.filter((scope) => scope.kind === "national")
        .length,
      1,
    );
    assert.equal(
      GEOGRAPHIC_PROPOSAL_SCOPES.some((scope) =>
        scope.label.startsWith("Fusion "),
      ),
      false,
      "geographic labels must not double as organisational branch names",
    );
  });

  it("maps organisational branches to geographic scopes without using names as identifiers", () => {
    assert.equal(
      geographicScopeForBranch({ branchId: "branch-vic" })?.key,
      "vic",
    );
    assert.equal(
      geographicScopeForBranch({
        branchId: "legacy-victoria",
        kind: "state",
        name: "Fusion Victoria",
      })?.key,
      "vic",
    );
    assert.equal(
      geographicScopeForBranch({
        branchId: "renamed",
        kind: "state",
        name: "Victoria — existing local name",
      })?.key,
      "vic",
    );
    assert.equal(
      geographicScopeForBranch({
        branchId: "act-branch",
        kind: "territory",
        stateCode: "ACT",
      })?.key,
      "act",
    );
    assert.equal(
      geographicScopeForBranch({
        branchId: "branch-nat",
        kind: "national",
        name: "Fusion National",
      })?.key,
      "national",
    );
    assert.equal(
      geographicScopeForBranch({
        branchId: "branch-melbourne",
        kind: "constituent",
        name: "Fusion Melbourne",
      }),
      undefined,
      "constituent branches remain organisational identities, not geographic scopes",
    );
    assert.equal(normalizeProposalScopeKey("Victoria"), null);
    assert.equal(normalizeProposalScopeKey("Fusion National"), null);
    assert.equal(normalizeProposalScopeKey("VIC"), "vic");
  });

  it("represents National once and only exposes branches the person administers", () => {
    const branches = [
      { branchId: "branch-nat", name: "Fusion National", kind: "national" },
      { branchId: "branch-vic", name: "Fusion Victoria", kind: "state" },
      { branchId: "branch-nsw", name: "Fusion New South Wales", kind: "state" },
      {
        branchId: "old-vic",
        name: "Fusion Victoria — legacy",
        kind: "state",
      },
      {
        branchId: "misclassified-national",
        name: "Fusion National",
        kind: "state",
      },
    ];

    const adminOptions = listAuthorisedProposalScopes(admin, branches);
    assert.equal(
      adminOptions.filter((option) => option.key === "national").length,
      1,
    );
    assert.equal(
      adminOptions.filter((option) => option.key === "vic").length,
      1,
      "duplicate legacy Victoria branches collapse to one geographic option",
    );
    assert.equal(
      adminOptions.some((option) => option.label === "Fusion National"),
      false,
    );

    const vicOnly = listAuthorisedProposalScopes(branchAdmin("branch-vic"), branches);
    assert.deepEqual(
      vicOnly.map((option) => option.key),
      ["national", "vic"],
    );
    assert.equal(vicOnly[1]?.branchName, "Fusion Victoria");

    const plainMember = listAuthorisedProposalScopes(member(), branches);
    assert.deepEqual(
      plainMember.map((option) => option.key),
      ["national"],
    );
  });

  it("defaults to the member's own authorised branch and never to an unauthorised one", () => {
    const branches = [
      { branchId: "branch-nat", name: "Fusion National", kind: "national" },
      { branchId: "branch-vic", name: "Fusion Victoria", kind: "state" },
      { branchId: "branch-nsw", name: "Fusion New South Wales", kind: "state" },
    ];
    const options = listAuthorisedProposalScopes(
      branchAdmin("branch-vic", { verifiedBranchIds: ["branch-vic"] }),
      branches,
    );
    assert.equal(defaultProposalScopeKey(branchAdmin("branch-vic"), options), "vic");
    assert.equal(
      defaultProposalScopeKey(
        branchAdmin("branch-vic", {
          verifiedBranchIds: ["branch-nsw"],
          activeBranchIds: ["branch-nsw"],
        }),
        options,
      ),
      "vic",
      "a verified branch the person cannot administer is not offered",
    );
    assert.equal(
      defaultProposalScopeKey(admin, listAuthorisedProposalScopes(admin, branches)),
      "national",
    );
  });

  it("keeps existing proposal records readable without rewriting their identifiers", async () => {
    const db = await seededDb();
    assert.equal(
      storedProposalScopeKey({ originatingBranchId: "National" }),
      "national",
    );
    assert.equal(
      storedProposalScopeKey({ originatingBranchId: "Fusion National" }),
      "national",
    );
    assert.equal(
      storedProposalScopeKey({ originatingBranchId: "branch-vic" }),
      "vic",
    );
    assert.equal(
      storedProposalScopeKey({ scope: "act", originatingBranchId: "legacy-x" }),
      "act",
    );
    assert.equal(storedProposalScopeKey({}), "national");

    assert.deepEqual(
      await describeProposalScope(db, { originatingBranchId: "National" }),
      { key: "national", label: "National", kind: "national" },
    );
    assert.deepEqual(
      await describeProposalScope(db, { originatingBranchId: "branch-vic" }),
      { key: "vic", label: "Victoria", kind: "state" },
    );
    assert.deepEqual(
      await describeProposalScope(db, {
        originatingBranchId: "branch-melbourne",
      }),
      { key: "branch-melbourne", label: "Fusion Melbourne", kind: "constituent" },
    );
  });
});

describe("proposal scope: server validation and permissions", () => {
  it("accepts canonical scope keys and stores a separate geographic scope", async () => {
    const db = await seededDb();
    const proposal = await saveProposal(
      db,
      admin,
      proposalSeed({ scope: "vic" }),
    );
    assert.equal(proposal.scope, "vic");
    assert.equal(proposal.originatingBranchId, "branch-vic");
    assert.equal(proposal.publicationScope, "branch");
  });

  it("allows verified members to choose National explicitly", async () => {
    const db = await seededDb();
    const proposal = await saveProposal(
      db,
      member(),
      proposalSeed({ scope: "national" }),
    );
    assert.equal(proposal.scope, "national");
    assert.equal(proposal.originatingBranchId, "branch-nat");
    assert.equal(proposal.publicationScope, "national");
  });

  it("rejects display labels, invalid keys, arrays and conflicting scopes", async () => {
    const db = await seededDb();
    for (const scope of ["Victoria", "Fusion National", "nationwide"]) {
      await assert.rejects(
        saveProposal(db, admin, proposalSeed({ scope })),
        /valid proposal scope/,
      );
    }
    await assert.rejects(
      saveProposal(db, admin, proposalSeed({ scope: ["vic"] })),
      /single valid proposal scope/,
    );
    await assert.rejects(
      saveProposal(
        db,
        admin,
        proposalSeed({ scope: "vic", originatingBranchId: "branch-nsw" }),
      ),
      /one proposal scope/,
    );
  });

  it("enforces branch administration independently of the rendered controls", async () => {
    const db = await seededDb();
    const vicAdmin = branchAdmin("branch-vic");
    const own = await saveProposal(
      db,
      vicAdmin,
      proposalSeed({ scope: "vic" }),
    );
    assert.equal(own.originatingBranchId, "branch-vic");

    await assert.rejects(
      saveProposal(db, vicAdmin, proposalSeed({ scope: "nsw" })),
      /only create proposals in their own branch/,
    );
    await assert.rejects(
      saveProposal(db, member(), proposalSeed({ scope: "vic" })),
      /only create proposals in their own branch/,
    );

    // Once a scope is set it cannot be reassigned through the API.
    await assert.rejects(
      saveProposal(db, vicAdmin, {
        proposalId: own.proposalId,
        scope: "national",
      }),
      /cannot be changed/,
    );
  });

  it("fails closed when duplicate branch records make a geographic scope ambiguous", async () => {
    const db = createMemoryDb();
    for (const branch of [
      {
        branchId: "legacy-vic-a",
        name: "Fusion Victoria",
        kind: "state",
        recognised: true,
      },
      {
        branchId: "legacy-vic-b",
        name: "Victoria",
        kind: "state",
        recognised: true,
      },
    ]) {
      await db.collection("branches").insertOne(branch as any);
    }
    await assert.rejects(
      saveProposal(db, admin, proposalSeed({ scope: "vic" })),
      /More than one Victoria branch/,
    );
  });
});

describe("proposal scope selector regression", () => {
  it("uses design-system primitives instead of a native dropdown", async () => {
    const component = await read(
      "src/components/proposal/ProposalScopeSelector.tsx",
    );
    assert.match(component, /ToggleGroup/);
    assert.match(component, /ToggleGroupItem/);
    assert.doesNotMatch(component, /<select/);
    assert.doesNotMatch(component, /NativeSelect/);
    assert.match(component, /type="hidden"/);
    assert.match(component, /aria-label="Proposal scope"/);
    assert.match(component, /aria-describedby="proposal-scope-hint"/);
    assert.match(component, /data-\[state=on\]/);
    assert.match(component, /min-h-11/, "touch targets must meet mobile sizing");
    assert.match(component, /flex-wrap/, "options must wrap on narrow screens");
    assert.match(component, /basis-\[calc\(50%/, "two columns on small screens");
  });

  it("keeps keyboard focus, labels and page wiring intact", async () => {
    const toggle = await read("src/components/ui/toggle.tsx");
    assert.match(toggle, /focus-visible:ring/, "focus must remain visible");
    assert.match(toggle, /aria-invalid/);

    const page = await read("src/pages/proposals/new/index.astro");
    assert.match(page, /ProposalScopeSelector/);
    assert.match(page, /client:load/);
    assert.doesNotMatch(page, /NativeSelect/);
    assert.doesNotMatch(page, /<select/);
    assert.doesNotMatch(page, /option value="national"/);
    assert.match(page, /\{ scope: scopeKey \}/);
    assert.doesNotMatch(page, /originatingBranchId: branchVal/);
  });
});
