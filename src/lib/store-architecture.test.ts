import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const LIB_DIR = path.resolve(import.meta.dirname);
const SRC_DIR = path.resolve(LIB_DIR, "..");

const DOMAIN_MODULES = [
  "proposal-helpers.ts",
  "proposals-store.ts",
  "comments-store.ts",
  "contribution-feedback.ts",
  "voting-store.ts",
  "members-store.ts",
] as const;

const SOURCE_EXTENSIONS = /\.(?:ts|tsx|astro|js|mjs)$/;

function listSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(dir)) {
    const entry = path.join(dir, name);
    if (statSync(entry).isDirectory()) {
      files.push(...listSourceFiles(entry));
    } else if (SOURCE_EXTENSIONS.test(name)) {
      files.push(entry);
    }
  }
  return files;
}

function extractModuleSpecifiers(source: string): string[] {
  const specifiers = new Set<string>();
  const staticRe = /\b(?:import|export)\b[\s\S]*?\bfrom\s+["']([^"']+)["']/g;
  const sideEffectRe = /(?:^|[;\n])\s*import\s+["']([^"']+)["']/g;
  const dynamicRe = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const re of [staticRe, sideEffectRe, dynamicRe]) {
    for (const match of source.matchAll(re)) {
      specifiers.add(match[1]);
    }
  }
  return [...specifiers];
}

function extractRelativeImports(source: string): string[] {
  const deps = new Set<string>();
  const staticRe = /\b(?:import|export)\b[\s\S]*?\bfrom\s+["']\.\/([^"']+)["']/g;
  const dynamicRe = /\bimport\s*\(\s*["']\.\/([^"']+)["']\s*\)/g;
  for (const re of [staticRe, dynamicRe]) {
    for (const match of source.matchAll(re)) {
      const target = match[1].endsWith(".ts") ? match[1] : `${match[1]}.ts`;
      deps.add(target);
    }
  }
  return [...deps];
}

function detectImportCycles(graph: Map<string, string[]>): string[] {
  const state = new Map<string, "visiting" | "visited">();
  const stack: string[] = [];
  const cycles: string[] = [];

  function dfs(node: string): void {
    state.set(node, "visiting");
    stack.push(node);

    for (const dep of graph.get(node) ?? []) {
      const depState = state.get(dep);
      if (depState === "visiting") {
        const start = stack.indexOf(dep);
        cycles.push([...stack.slice(start), dep].join(" -> "));
      } else if (!depState && graph.has(dep)) {
        dfs(dep);
      }
    }

    stack.pop();
    state.set(node, "visited");
  }

  for (const node of graph.keys()) {
    if (!state.has(node)) dfs(node);
  }

  return cycles;
}

test("src/lib/store.ts stays deleted and must not be reintroduced", () => {
  assert.equal(
    existsSync(path.join(LIB_DIR, "store.ts")),
    false,
    "src/lib/store.ts must not exist. Import proposals, comments, votes, members and contribution feedback from their domain modules instead of a compatibility barrel",
  );
});

test("no source file imports the removed store.ts barrel", () => {
  const offenders: string[] = [];

  for (const file of listSourceFiles(SRC_DIR)) {
    const source = readFileSync(file, "utf8");
    for (const specifier of extractModuleSpecifiers(source)) {
      if (/(?:^|\/)store(?:\.ts)?$/.test(specifier)) {
        offenders.push(
          `${path.relative(SRC_DIR, file)} imports "${specifier}"; import from the owning domain module instead`,
        );
      }
    }
  }

  assert.deepEqual(offenders, [], offenders.join("\n"));
});

test("production src/lib modules do not import page or component directories", () => {
  const offenders: string[] = [];
  const files = listSourceFiles(LIB_DIR).filter(
    (file) => !file.endsWith(".test.ts") && !file.endsWith(".test.tsx"),
  );

  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const specifier of extractModuleSpecifiers(source)) {
      if (/(?:^|\/)\.\.\/(?:pages|components|layouts)\//.test(specifier)) {
        offenders.push(
          `${path.relative(LIB_DIR, file)} imports "${specifier}"; production domain modules must not depend on routed pages or UI components`,
        );
      }
    }
  }

  assert.deepEqual(offenders, [], offenders.join("\n"));
});

test("extracted domain modules form an acyclic dependency graph", () => {
  const domainSet = new Set<string>(DOMAIN_MODULES);
  const graph = new Map<string, string[]>();

  for (const mod of DOMAIN_MODULES) {
    const source = readFileSync(path.join(LIB_DIR, mod), "utf8");
    const deps = extractRelativeImports(source).filter((dep) => domainSet.has(dep));
    graph.set(mod, deps);
  }

  const cycles = detectImportCycles(graph);
  assert.deepEqual(
    cycles,
    [],
    `Circular dependency detected between extracted domain modules: ${cycles.join("; ")}`,
  );
});

test("detectImportCycles catches circular dependencies between domain modules", () => {
  const graph = new Map<string, string[]>([
    ["proposal-helpers.ts", []],
    ["proposals-store.ts", ["proposal-helpers.ts", "voting-store.ts"]],
    ["voting-store.ts", ["proposal-helpers.ts", "proposals-store.ts"]],
  ]);

  const cycles = detectImportCycles(graph);
  assert.deepEqual(cycles, ["proposals-store.ts -> voting-store.ts -> proposals-store.ts"]);
});
