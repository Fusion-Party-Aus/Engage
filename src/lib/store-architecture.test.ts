import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const LIB_DIR = path.resolve(import.meta.dirname);

const DOMAIN_MODULES = [
  "proposal-helpers.ts",
  "proposals-store.ts",
  "comments-store.ts",
  "contribution-feedback.ts",
  "voting-store.ts",
  "members-store.ts",
] as const;

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

test("store.ts remains a thin compatibility barrel without domain logic", () => {
  const storeSource = readFileSync(path.join(LIB_DIR, "store.ts"), "utf8");
  const lines = storeSource.split("\n");

  assert.ok(
    lines.length <= 150,
    `src/lib/store.ts must remain a thin barrel (<= 150 lines), found ${lines.length} lines`,
  );
  assert.doesNotMatch(
    storeSource,
    /\basync\s+function\b/,
    "src/lib/store.ts must not define async functions; place domain logic in a focused module",
  );
  assert.doesNotMatch(
    storeSource,
    /\.collection\s*[<(]/,
    "src/lib/store.ts must not query MongoDB directly",
  );
});

test("production src/lib modules import specific domain modules instead of store.ts", () => {
  const files = readdirSync(LIB_DIR).filter(
    (name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && name !== "store.ts",
  );

  const offenders: string[] = [];
  for (const file of files) {
    const content = readFileSync(path.join(LIB_DIR, file), "utf8");
    if (/from\s+["']\.\/store(?:\.ts)?["']/.test(content)) {
      offenders.push(file);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `Production src/lib modules must import domain modules directly instead of ./store.ts: ${offenders.join(", ")}`,
  );
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
