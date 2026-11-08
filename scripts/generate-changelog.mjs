#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(__dirname, "../src/data/changelog.json");

const CONVENTIONAL_RE = /^([a-z]+)(?:\(([^)]+)\))?!?:\s*(.+)$/i;

function parseCommit(line) {
  const [hash, date, subject, body = ""] = line.split("\x1f");
  if (!hash || !date || !subject) return null;

  const trimmed = subject.trim();
  // Skip pure noise merge commits unless they carry a release summary
  if (/^Merge pull request/i.test(trimmed)) return null;

  const match = trimmed.match(CONVENTIONAL_RE);
  const rawType = match ? match[1].toLowerCase() : "update";
  const scope = match && match[2] ? match[2].toLowerCase() : "platform";
  const summary = match ? match[3].trim() : trimmed;

  const category =
    rawType === "feat" || rawType === "release"
      ? "feature"
      : rawType === "fix"
        ? "fix"
        : rawType === "perf" || rawType === "refactor" || rawType === "style"
          ? "improvement"
          : rawType === "docs"
            ? "docs"
            : "ops";

  const cleanBody = body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^Co-authored-by:/i.test(l))
    .join(" ");

  return {
    hash: hash.trim(),
    date: date.trim(),
    type: rawType,
    category,
    scope,
    summary: summary[0] ? summary[0].toUpperCase() + summary.slice(1) : summary,
    ...(cleanBody ? { details: cleanBody } : {}),
  };
}

try {
  const raw = execFileSync(
    "git",
    [
      "log",
      "--no-merges",
      "-n",
      "80",
      "--date=short",
      "--pretty=format:%h%x1f%ad%x1f%s%x1f%b%x1e",
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );

  const entries = raw
    .split("\x1e")
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map(parseCommit)
    .filter(Boolean);

  if (entries.length > 0) {
    writeFileSync(outPath, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
    console.log(`[changelog] Wrote ${entries.length} git commit entries to src/data/changelog.json`);
  }
} catch {
  if (existsSync(outPath)) {
    const existing = JSON.parse(readFileSync(outPath, "utf8"));
    console.log(`[changelog] Git unavailable; keeping existing ${existing.length} entries in src/data/changelog.json`);
  } else {
    writeFileSync(outPath, "[]\n", "utf8");
  }
}
