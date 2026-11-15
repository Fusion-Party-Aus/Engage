#!/usr/bin/env node
// Checks that relative links in the documentation resolve to real files.
// Dependency-free: run with `pnpm docs:check-links`.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

function markdownFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return markdownFiles(path);
    return entry.name.endsWith('.md') ? [path] : [];
  });
}

// Links inside fenced blocks or inline code are illustrative, not navigable.
function prose(text) {
  return text
    .replace(/^ {0,3}(```|~~~)[\s\S]*?^ {0,3}\1/gm, '')
    .replace(/`[^`\n]*`/g, '');
}

const linkPattern = /\[[^\]]*\]\(\s*(<[^>\n]*>|[^)\s]+)/g;
const ignoredScheme = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

function decodePath(path) {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

const files = [
  join(root, 'README.md'),
  join(root, 'AGENTS.md'),
  ...markdownFiles(join(root, 'docs')),
].filter((file) => existsSync(file));

let checked = 0;
const broken = [];

for (const file of files) {
  const text = prose(readFileSync(file, 'utf8'));
  for (const match of text.matchAll(linkPattern)) {
    const raw = match[1].replace(/^<|>$/g, '');
    // `#fragment` links stay in the page; `{{ placeholder }}` links are message templates.
    if (!raw || raw.startsWith('#') || raw.startsWith('{{') || ignoredScheme.test(raw)) continue;

    // Fragment and query are not part of the path on disk.
    const target = raw.split(/[?#]/)[0];
    if (!target) continue;

    checked += 1;
    const path = resolve(dirname(file), decodePath(target));
    if (!existsSync(path)) {
      broken.push(`${relative(root, file)} -> ${raw}`);
    }
  }
}

for (const entry of broken) console.error(entry);
console.log(
  `checked ${checked} relative links in ${files.length} files, broken: ${broken.length}`,
);
process.exitCode = broken.length > 0 ? 1 : 0;
