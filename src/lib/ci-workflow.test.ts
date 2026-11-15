import { it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../../", import.meta.url);
const read = (path: string) => readFile(new URL(path, root), "utf8");

const HARNESS = "scripts/security-perimeter-browser.mjs";
const PLAYWRIGHT_MODULE =
  /ENGAGE_PLAYWRIGHT_MODULE: \$\{\{ runner\.temp \}\}\/engage-browser\/node_modules\/playwright\/index\.mjs/;

// Steps live at six spaces of indentation under `steps:`. Grouping complete
// step blocks lets the assertions compare positions, not just presence.
function workflowSteps(workflow: string): string[] {
  const steps: string[] = [];
  for (const line of workflow.split("\n")) {
    if (/^ {6}- /.test(line)) steps.push(`${line}\n`);
    else if (steps.length > 0) steps[steps.length - 1] += `${line}\n`;
  }
  return steps;
}

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

it("CI runs the perimeter browser harness after the build and the Playwright install", async () => {
  const [packageJson, workflow] = await Promise.all([
    read("package.json"),
    read(".github/workflows/ci.yml"),
  ]);
  const scripts = (JSON.parse(packageJson) as { scripts: Record<string, string> })
    .scripts;
  const steps = workflowSteps(workflow);

  const harness = await read(HARNESS).catch(() => undefined);
  assert.ok(
    harness,
    `ci.yml and 'perimeter:browser' both reference ${HARNESS}, so the file must exist`,
  );

  const findStep = (pattern: RegExp, label: string) => {
    const matches = steps
      .map((step, index) => ({ step, index }))
      .filter(({ step }) => pattern.test(step));
    assert.equal(
      matches.length,
      1,
      `ci.yml must contain exactly one step ${label}; found ${matches.length}`,
    );
    return matches[0]!;
  };

  const perimeter = findStep(
    new RegExp(`run:\\s*node ${HARNESS.replaceAll("/", "\\/")}`),
    `running ${HARNESS}`,
  );
  const build = findStep(/^ {6}- run: pnpm build$/m, "running 'pnpm build'");
  const playwright = findStep(
    /npm install --prefix .*playwright@\d/,
    "installing Playwright into the runner temporary directory",
  );

  assert.ok(
    perimeter.index > build.index,
    "the perimeter harness must run after the production build",
  );
  assert.ok(
    perimeter.index > playwright.index,
    "the perimeter harness must run after the Playwright install, not before it",
  );
  assert.equal(
    steps.filter((step) => /npm install --prefix .*playwright@\d/.test(step)).length,
    1,
    "Playwright must be installed once and shared with the perimeter harness",
  );
  assert.equal(
    /npm install|playwright\/cli\.js install/.test(perimeter.step),
    false,
    "the perimeter step must reuse the installed Playwright rather than install it",
  );
  assert.match(
    perimeter.step,
    PLAYWRIGHT_MODULE,
    "the perimeter step must pass the shared ENGAGE_PLAYWRIGHT_MODULE path",
  );

  assert.equal(
    scripts["perimeter:browser"],
    `node ${HARNESS}`,
    `package.json must expose 'perimeter:browser' as 'node ${HARNESS}', the same harness the workflow runs`,
  );
  assert.match(
    harness!,
    /ENGAGE_PERIMETER_TIMEOUT_MS/,
    `${HARNESS} must keep a configurable hard timeout so a hung run fails the job`,
  );
});
