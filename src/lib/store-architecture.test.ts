import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const LIB_DIR = path.resolve(import.meta.dirname);

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
