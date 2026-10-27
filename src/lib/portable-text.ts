/**
 * Portable Text & Markdown renderer for Engage
 * Converts markdown text (headings, bold headers, lists, links, inline styles) into clean, semantic HTML.
 */

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function parseInline(text: string): string {
  let out = escapeHtml(text);

  // Inline code: `code`
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");

  // Markdown links: [text](https://...) or [text](/relative/path)
  out = out.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
  );
  out = out.replace(/\[([^\]]+)\]\((\/[^\s)]*)\)/g, '<a href="$2">$1</a>');

  // Bold: **text** or __text__
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/__([^_]+)__/g, "<strong>$1</strong>");

  // Italic: *text* or _text_ (when not part of a word or strong tag)
  out = out.replace(/(^|[^*])\*([^*]+)\*([^*]|$)/g, "$1<em>$2</em>$3");
  out = out.replace(/(^|[^_])_([^_]+)_([^_]|$)/g, "$1<em>$2</em>$3");

  return out;
}

export interface RenderOptions {
  /**
   * If true, transforms standalone bold lines like `**Design rationale**` into `<h3>Design rationale</h3>`.
   * Defaults to true, matching Reclaim policy section headers.
   */
  boldHeadings?: boolean;
}

export function renderPortableText(markdown: string, options: RenderOptions = {}): string {
  if (!markdown || typeof markdown !== "string") return "";

  const boldHeadings = options.boldHeadings !== false;
  const lines = markdown.split(/\r?\n/);
  const html: string[] = [];

  let inUl = false;
  let inOl = false;
  let inBlockquote = false;
  let paragraph: string[] = [];

  function flushParagraph() {
    if (paragraph.length > 0) {
      html.push(`<p>${parseInline(paragraph.join(" "))}</p>`);
      paragraph = [];
    }
  }

  function closeLists() {
    if (inUl) {
      html.push("</ul>");
      inUl = false;
    }
    if (inOl) {
      html.push("</ol>");
      inOl = false;
    }
  }

  function closeBlockquote() {
    if (inBlockquote) {
      html.push("</blockquote>");
      inBlockquote = false;
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

    // Blank line terminates active paragraph and lists/blockquotes
    if (!trimmed) {
      flushParagraph();
      closeLists();
      closeBlockquote();
      continue;
    }

    // Standard markdown headings: # Heading through ###### Heading
    const hashMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (hashMatch) {
      flushParagraph();
      closeLists();
      closeBlockquote();
      // Map # to h2, ## to h3, etc. since the proposal title is h1
      const level = Math.min(6, hashMatch[1].length + 1);
      html.push(`<h${level}>${parseInline(hashMatch[2])}</h${level}>`);
      continue;
    }

    // Standalone bold heading: **Section Heading**
    if (boldHeadings) {
      const boldHeaderMatch = trimmed.match(/^\*\*([^*]+)\*\*$/);
      if (boldHeaderMatch) {
        flushParagraph();
        closeLists();
        closeBlockquote();
        html.push(`<h3>${parseInline(boldHeaderMatch[1])}</h3>`);
        continue;
      }
    }

    // Blockquote: > quote line
    const quoteMatch = trimmed.match(/^>\s*(.+)$/);
    if (quoteMatch) {
      flushParagraph();
      closeLists();
      if (!inBlockquote) {
        html.push("<blockquote>");
        inBlockquote = true;
      }
      html.push(`<p>${parseInline(quoteMatch[1])}</p>`);
      continue;
    } else if (inBlockquote) {
      closeBlockquote();
    }

    // Ordered list: 1. Item
    const olMatch = trimmed.match(/^(\d+)\.\s+(.+)$/);
    if (olMatch) {
      flushParagraph();
      if (inUl) {
        html.push("</ul>");
        inUl = false;
      }
      if (!inOl) {
        html.push("<ol>");
        inOl = true;
      }
      html.push(`<li>${parseInline(olMatch[2])}</li>`);
      continue;
    }

    // Unordered list: - Item or * Item
    const ulMatch = trimmed.match(/^[-*]\s+(.+)$/);
    if (ulMatch) {
      flushParagraph();
      if (inOl) {
        html.push("</ol>");
        inOl = false;
      }
      if (!inUl) {
        html.push("<ul>");
        inUl = true;
      }
      html.push(`<li>${parseInline(ulMatch[1])}</li>`);
      continue;
    }

    // Regular paragraph line
    closeLists();
    paragraph.push(trimmed);
  }

  flushParagraph();
  closeLists();
  closeBlockquote();

  return html.join("\n");
}
