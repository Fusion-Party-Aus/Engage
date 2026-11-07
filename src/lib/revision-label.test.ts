import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  revisionDisplayLabel,
  revisionReferenceLabel,
} from "./revision-label.ts";

describe("member-facing revision labels", () => {
  it("replaces technical legacy identifiers with a plain-language label", () => {
    const label = revisionDisplayLabel({
      revisionId: "legacy-0a1b2c3d",
      createdAt: "2026-10-27T08:35:23.933Z",
    });
    assert.equal(label, "Original recorded wording · 27 Oct 2026");
    assert.equal(label.includes("legacy"), false);
  });

  it("labels numbered revisions with their date", () => {
    assert.equal(
      revisionDisplayLabel({
        revisionId: "rev-2",
        createdAt: "2026-11-02T00:00:00.000Z",
        ordinal: 2,
      }),
      "Wording revision 2 · 2 Nov 2026",
    );
  });

  it("keeps the exact immutable reference available for audit views", () => {
    assert.equal(
      revisionReferenceLabel("legacy-0a1b2c3d"),
      "legacy-0a1b2c3d",
    );
  });
});
