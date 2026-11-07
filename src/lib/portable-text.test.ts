import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  escapeHtml,
  parseInline,
  renderPortableText,
} from "./portable-text.ts";

describe("Portable Text & Markdown Renderer", () => {
  it("escapes raw HTML entities safely", () => {
    assert.equal(
      escapeHtml('<script>alert("xss")</script> & "me"'),
      "&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt; &amp; &quot;me&quot;",
    );
  });

  it("parses inline links, bold, italics, and code", () => {
    const raw =
      "See [Fusion Website](https://fusionparty.org.au) or [internal link](/proposals) with **bold**, *italic*, and `const x = 1`.";
    const parsed = parseInline(raw);

    assert.ok(
      parsed.includes(
        '<a href="https://fusionparty.org.au" target="_blank" rel="noopener noreferrer">Fusion Website</a>',
      ),
    );
    assert.ok(parsed.includes('<a href="/proposals">internal link</a>'));
    assert.ok(parsed.includes("<strong>bold</strong>"));
    assert.ok(parsed.includes("<em>italic</em>"));
    assert.ok(parsed.includes("<code>const x = 1</code>"));
  });

  it("renders markdown headings (# to ######) as semantic h2-h6", () => {
    const md = "# Top Level\n\n## Sub Level\n\n### Minor Heading";
    const html = renderPortableText(md);

    assert.ok(html.includes("<h2>Top Level</h2>"));
    assert.ok(html.includes("<h3>Sub Level</h3>"));
    assert.ok(html.includes("<h4>Minor Heading</h4>"));
  });

  it("transforms standalone bold headers into h3", () => {
    const md =
      "**Design rationale**\n\nThis is the rationale body text.\n\n**Risk and failure modes**\n\nThis outlines the risks.";
    const html = renderPortableText(md);

    assert.ok(html.includes("<h3>Design rationale</h3>"));
    assert.ok(html.includes("<p>This is the rationale body text.</p>"));
    assert.ok(html.includes("<h3>Risk and failure modes</h3>"));
    assert.ok(html.includes("<p>This outlines the risks.</p>"));
  });

  it("renders ordered and unordered lists properly", () => {
    const md = `
**Key Steps**

1. First milestone
2. Second milestone with **bold** details

- Bullet item A
- Bullet item B with [link](/member)
`;
    const html = renderPortableText(md);

    assert.ok(html.includes("<ol>"));
    assert.ok(html.includes("<li>First milestone</li>"));
    assert.ok(
      html.includes(
        "<li>Second milestone with <strong>bold</strong> details</li>",
      ),
    );
    assert.ok(html.includes("</ol>"));

    assert.ok(html.includes("<ul>"));
    assert.ok(html.includes("<li>Bullet item A</li>"));
    assert.ok(
      html.includes('<li>Bullet item B with <a href="/member">link</a></li>'),
    );
    assert.ok(html.includes("</ul>"));
  });

  it("renders blockquotes cleanly", () => {
    const md =
      "> This is an important quote from the working group charter.\n\nNormal paragraph.";
    const html = renderPortableText(md);

    assert.ok(html.includes("<blockquote>"));
    assert.ok(
      html.includes(
        "<p>This is an important quote from the working group charter.</p>",
      ),
    );
    assert.ok(html.includes("</blockquote>"));
    assert.ok(html.includes("<p>Normal paragraph.</p>"));
  });

  it("handles empty or whitespace inputs gracefully", () => {
    assert.equal(renderPortableText(""), "");
    assert.equal(renderPortableText("   \n\n   "), "");
  });
});
