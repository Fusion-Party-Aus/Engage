import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../../", import.meta.url);
const read = (path: string) => readFile(new URL(path, root), "utf8");

describe("policy change proposal form", () => {
  it("lets the selected action drive the title, question and visible fields", async () => {
    const [page, selector] = await Promise.all([
      read("src/pages/proposals/new/index.astro"),
      read("src/components/proposal/PolicyChangeTypeSelector.tsx"),
    ]);

    // The selector announces the choice; the page owns the copy and fields.
    assert.match(selector, /new CustomEvent\('policy-change-type'/);
    assert.match(page, /addEventListener\('policy-change-type'/);
    assert.match(
      page,
      /titleInput\.value = `\$\{copy\.label\}: \$\{policyTitle\}`/,
      "the default title must follow the chosen action",
    );
    assert.match(page, /summaryLabel\.textContent = copy\.summaryLabel/);
    assert.match(page, /summaryInput\.placeholder = copy\.summaryPlaceholder/);
    assert.match(page, /effectNote\.textContent = copy\.effect/);

    // Only the fields that make sense for the action are revealed.
    assert.match(page, /data-change-panel="amend"/);
    assert.match(page, /data-change-panel="replace"/);
    assert.match(page, /changeOutcomes\.hidden = type === 'repeal'/);
    assert.match(page, /defaultPolicyChangeTitle/);
    assert.match(page, /POLICY_CHANGE_GUIDANCE/);
  });

  it("inherits the policy topic and shows existing change proposals", async () => {
    const page = await read("src/pages/proposals/new/index.astro");

    assert.match(page, /name="space" value=\{inheritedSpace\}/);
    assert.match(page, /targetPolicyId: targetPolicy\.policyId/);
    assert.match(
      page,
      /canViewProposal\(normalizeProposalDoc\(row\), user\)/,
      "existing proposals must respect the same visibility rule as the proposal page",
    );
    assert.match(page, /This policy already has/);
    assert.match(page, /Join the discussion there/);
  });
});
