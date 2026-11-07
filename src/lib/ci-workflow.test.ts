import { it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../../", import.meta.url);
const read = (path: string) => readFile(new URL(path, root), "utf8");

it("CI workflows use existing package scripts and enable real MongoDB suites", async () => {
  const [packageJson, nucWorkflow, applicationWorkflow] = await Promise.all([
    read("package.json"),
    read(".github/workflows/nuc-cicd.yml"),
    read(".github/workflows/ci.yml"),
  ]);
  const scripts = Object.keys(
    (JSON.parse(packageJson) as { scripts: Record<string, string> }).scripts,
  );

  for (const [name, workflow] of [
    ["nuc-cicd.yml", nucWorkflow],
    ["ci.yml", applicationWorkflow],
  ] as const) {
    assert.equal(
      workflow.includes("test:cutoff"),
      false,
      `${name} must not call the removed test:cutoff script`,
    );
    assert.equal(
      workflow.includes("test:auth"),
      false,
      `${name} must not call the removed test:auth script`,
    );
    assert.match(
      workflow,
      /VOTING_TEST_MONGODB_URI:/,
      `${name} must provide the real MongoDB voting test URI`,
    );
    assert.match(
      workflow,
      /AUTH_TEST_MONGODB_URI:/,
      `${name} must provide the real MongoDB authentication test URI`,
    );
  }

  const builtInCommands = new Set([
    "add",
    "dlx",
    "exec",
    "install",
    "remove",
    "run",
  ]);
  const referenced = nucWorkflow
    .split("\n")
    .map((line) => line.match(/^\s*(?:-\s*)?run:\s+pnpm\s+([a-zA-Z0-9:_-]+)/))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .map((match) => match[1]!);
  for (const name of referenced) {
    if (builtInCommands.has(name)) continue;
    assert.ok(
      scripts.includes(name),
      `nuc-cicd.yml references missing package script '${name}'`,
    );
  }
  assert.ok(referenced.includes("test"));
});
