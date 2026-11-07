import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../../", import.meta.url);
const read = (path: string) => readFile(new URL(path, root), "utf8");

describe("Astro/React rendering regression", () => {
  it("does not enable experimental React children, which double-escaped Astro slot text", async () => {
    const config = await read("astro.config.mjs");
    assert.equal(
      config.includes("experimentalReactChildren"),
      false,
      "experimentalReactChildren caused literal &amp; labels and React DOM property warnings",
    );
  });

  it("keeps the portable-text renderer on the safe escaped path", async () => {
    const source = await read("src/lib/portable-text.ts");
    assert.match(source, /escapeHtml/);
    assert.match(source, /&quot;/);
    assert.equal(
      source.includes("dangerouslySetInnerHTML"),
      false,
      "proposal content must continue to be escaped",
    );
  });
});
