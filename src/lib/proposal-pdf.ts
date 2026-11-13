import { isGovernanceResolution } from "./store.ts";
import type { CommentRecord, ProposalSummaryView } from "./types.ts";

export interface ProposalPdfReportInput {
  proposal: ProposalSummaryView;
  comments: CommentRecord[];
  jurisdictionName: string;
  originatingBranchName: string;
  authorityBranchName: string;
  ballotOpenedAt?: Date;
  ballotResult?: {
    result: string;
    decisionEventId?: string;
    recordedAt?: Date;
  } | null;
  policyRecord?: {
    policyId: string;
    status?: string;
    publicationStatus?: string;
    ratification?: { ratifiedAt?: Date; decisionEventId?: string };
    publishedAt?: Date;
  } | null;
  generatedAt?: Date;
}

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN_X = 48;
const MARGIN_TOP = 54;
const MARGIN_BOTTOM = 52;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN_X * 2;

function sanitizePdfText(input: string): string {
  return String(input ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\u2014/g, " - ")
    .replace(/\u2013/g, "-")
    .replace(/\u2022/g, "*")
    .replace(/\u2192/g, "->")
    .replace(/\u2026/g, "...")
    .replace(/\u00A0/g, " ")
    .replace(/[^\x20-\x7E\xA1-\xFF\n]/g, "?");
}

function pdfLiteral(text: string): string {
  const clean = sanitizePdfText(text).replace(/\n/g, " ");
  let out = "";
  for (let i = 0; i < clean.length; i++) {
    const code = clean.charCodeAt(i);
    if (clean[i] === "\\" || clean[i] === "(" || clean[i] === ")") {
      out += `\\${clean[i]}`;
    } else if (code >= 32 && code <= 126) {
      out += clean[i];
    } else if (code >= 160 && code <= 255) {
      out += `\\${code.toString(8).padStart(3, "0")}`;
    } else {
      out += "?";
    }
  }
  return `(${out})`;
}

function approxCharWidth(fontSize: number, bold = false): number {
  return fontSize * (bold ? 0.54 : 0.5);
}

function wrapLines(
  text: string,
  maxWidth: number,
  fontSize: number,
  bold = false,
): string[] {
  const clean = sanitizePdfText(text);
  const maxChars = Math.max(16, Math.floor(maxWidth / approxCharWidth(fontSize, bold)));
  const paragraphs = clean.split("\n");
  const lines: string[] = [];

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) {
      lines.push("");
      continue;
    }
    const words = trimmed.split(/\s+/);
    let current = "";
    for (const word of words) {
      if (!current) {
        if (word.length <= maxChars) {
          current = word;
        } else {
          for (let i = 0; i < word.length; i += maxChars) {
            const slice = word.slice(i, i + maxChars);
            if (slice.length === maxChars) lines.push(slice);
            else current = slice;
          }
        }
      } else if (current.length + 1 + word.length <= maxChars) {
        current += ` ${word}`;
      } else {
        lines.push(current);
        current = word;
      }
    }
    if (current) lines.push(current);
  }

  return lines;
}

function formatDate(value?: Date | string | null): string {
  if (!value) return "Not recorded";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "Not recorded";
  return d.toLocaleDateString("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function stageLabel(stage: string): string {
  switch (stage) {
    case "propose":
      return "1. Propose (Intake)";
    case "deliberate":
      return "2. Deliberate (Discussion)";
    case "decide":
      return "3. Decide (Ballot)";
    case "implement":
      return "4. Implement (Post-ballot)";
    case "archived":
      return "Archived";
    default:
      return stage;
  }
}

export function buildProposalPdfReport(input: ProposalPdfReportInput): Uint8Array {
  const {
    proposal,
    comments,
    jurisdictionName,
    originatingBranchName,
    authorityBranchName,
    ballotOpenedAt,
    ballotResult,
    policyRecord,
    generatedAt = new Date(),
  } = input;

  const isResolution = isGovernanceResolution(proposal);
  const typeLabel = isResolution ? "Governance resolution" : "Policy proposal";
  const scopeLabel =
    proposal.publicationScope === "private"
      ? "Private draft (restricted)"
      : proposal.publicationScope === "branch"
        ? "Branch-scoped (internal)"
        : "National / public";

  const pages: string[][] = [[]];
  let cursorY = PAGE_HEIGHT - MARGIN_TOP;

  const currentPage = () => pages[pages.length - 1]!;
  const newPage = () => {
    pages.push([]);
    cursorY = PAGE_HEIGHT - MARGIN_TOP;
  };
  const ensureSpace = (needed: number) => {
    if (cursorY - needed < MARGIN_BOTTOM + 20) {
      newPage();
    }
  };

  const drawText = (
    text: string,
    x: number,
    y: number,
    opts: { font?: "F1" | "F2" | "F3"; size?: number; color?: string } = {},
  ) => {
    const font = opts.font ?? "F1";
    const size = opts.size ?? 10;
    const color = opts.color ?? "0.14 0.11 0.19";
    currentPage().push(
      `BT ${color} rg /${font} ${size} Tf 1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm ${pdfLiteral(text)} Tj ET`,
    );
  };

  const drawRect = (x: number, y: number, w: number, h: number, rgb: string) => {
    currentPage().push(`${rgb} rg ${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f`);
  };

  const drawLine = (x1: number, y1: number, x2: number, y2: number, rgb = "0.87 0.84 0.91", width = 0.75) => {
    currentPage().push(
      `${rgb} RG ${width} w ${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(2)} ${y2.toFixed(2)} l S`,
    );
  };

  const addWrappedParagraph = (
    text: string,
    opts: { font?: "F1" | "F2" | "F3"; size?: number; leading?: number; color?: string; x?: number; width?: number } = {},
  ) => {
    const size = opts.size ?? 10;
    const leading = opts.leading ?? size * 1.42;
    const x = opts.x ?? MARGIN_X;
    const width = opts.width ?? CONTENT_WIDTH;
    const bold = opts.font === "F2";
    const lines = wrapLines(text, width, size, bold);
    for (const line of lines) {
      ensureSpace(leading);
      if (line) {
        drawText(line, x, cursorY, { font: opts.font, size, color: opts.color });
      }
      cursorY -= leading;
    }
  };

  const addSectionHeading = (title: string) => {
    ensureSpace(34);
    cursorY -= 8;
    drawText(title, MARGIN_X, cursorY, {
      font: "F2",
      size: 12,
      color: "0.196 0.063 0.353",
    });
    cursorY -= 6;
    drawLine(MARGIN_X, cursorY, PAGE_WIDTH - MARGIN_X, cursorY, "0.82 0.78 0.89", 1);
    cursorY -= 14;
  };

  const addKeyValueRow = (label: string, value: string) => {
    const labelWidth = 155;
    const valueWidth = CONTENT_WIDTH - labelWidth;
    const valueLines = wrapLines(value, valueWidth, 9.5, false);
    const rowHeight = Math.max(1, valueLines.length) * 13.5 + 3;
    ensureSpace(rowHeight);
    drawText(label, MARGIN_X, cursorY, {
      font: "F2",
      size: 9.5,
      color: "0.33 0.27 0.37",
    });
    for (let i = 0; i < valueLines.length; i++) {
      if (valueLines[i]) {
        drawText(valueLines[i]!, MARGIN_X + labelWidth, cursorY - i * 13.5, {
          font: "F1",
          size: 9.5,
          color: "0.14 0.11 0.19",
        });
      }
    }
    cursorY -= rowHeight;
  };

  // Top Horizon brand accent bar on page 1
  drawRect(MARGIN_X, PAGE_HEIGHT - 36, CONTENT_WIDTH, 4, "0.196 0.063 0.353");
  drawRect(MARGIN_X, PAGE_HEIGHT - 36, 96, 4, "0.000 0.788 0.824");

  drawText("FUSION PARTY AUSTRALIA · ENGAGE GOVERNANCE REPORT", MARGIN_X, cursorY, {
    font: "F2",
    size: 8.5,
    color: "0.33 0.27 0.37",
  });
  cursorY -= 18;

  // Title
  addWrappedParagraph(proposal.title, {
    font: "F2",
    size: 17,
    leading: 22,
    color: "0.15 0.06 0.28",
  });
  cursorY -= 4;

  // Summary / brief
  if (proposal.summary) {
    addWrappedParagraph(proposal.summary, {
      font: "F1",
      size: 10,
      leading: 14.5,
      color: "0.28 0.24 0.33",
    });
    cursorY -= 6;
  }

  // Record metadata
  addSectionHeading("1. Proposal & Governance Metadata");
  addKeyValueRow("Identifier", proposal.proposalId);
  addKeyValueRow("Record type", typeLabel);
  addKeyValueRow("Topic / space", proposal.space || "General");
  addKeyValueRow("Current stage", stageLabel(proposal.stage));
  addKeyValueRow("Jurisdiction", jurisdictionName);
  addKeyValueRow("Originating branch", originatingBranchName);
  addKeyValueRow("Governance authority", authorityBranchName);
  addKeyValueRow("Circulation scope", scopeLabel);
  if (policyRecord) {
    addKeyValueRow(
      "Policy registry",
      `${policyRecord.policyId} (${policyRecord.status ?? "adopted"} / ${policyRecord.publicationStatus ?? "unpublished"})`,
    );
  }

  // Ballot status & totals
  addSectionHeading("2. Ballot Status & Aggregate Results");
  const isOpenBallot = proposal.stage === "decide" && !ballotResult;
  const ballotStatusText = ballotResult
    ? `Completed — outcome recorded as "${ballotResult.result}" (${formatDate(ballotResult.recordedAt)}${ballotResult.decisionEventId ? `, ref: ${ballotResult.decisionEventId}` : ""})`
    : isOpenBallot
      ? "Ballot currently open — figures below are interim totals and not a final result"
      : proposal.votes.total > 0
        ? "Voting closed — formal outcome not yet recorded"
        : "Voting has not opened";

  addKeyValueRow("Ballot status", ballotStatusText);
  addKeyValueRow("Voting start date", formatDate(ballotOpenedAt));
  addKeyValueRow("Voting closing date", formatDate(proposal.ballotClosesAt));

  const total = proposal.votes.total;
  const pct = (n: number) => (total > 0 ? `${Math.round((n / total) * 100)}%` : "0%");
  addKeyValueRow("Total votes cast", `${total} verified ballot${total === 1 ? "" : "s"}`);
  addKeyValueRow("Approve", `${proposal.votes.approve} (${pct(proposal.votes.approve)})`);
  addKeyValueRow("Reject", `${proposal.votes.reject} (${pct(proposal.votes.reject)})`);
  addKeyValueRow("Abstain", `${proposal.votes.abstain} (${pct(proposal.votes.abstain)})`);

  if (isOpenBallot) {
    cursorY -= 2;
    addWrappedParagraph(
      "Notice: This ballot is still open. Interim totals do not represent a final outcome.",
      { font: "F3", size: 9, leading: 13, color: "0.35 0.23 0.02" },
    );
  }
  if (!isResolution) {
    cursorY -= 2;
    addWrappedParagraph(
      "Governance note: A successful ballot outcome alone does not constitute formal policy adoption. Formal ratification and public publication are separate governance steps.",
      { font: "F3", size: 9, leading: 13, color: "0.33 0.27 0.37" },
    );
  }

  // Recorded outcomes & notes
  if (
    proposal.implementationNote ||
    proposal.supersededByProposalId ||
    proposal.supersededByNote ||
    policyRecord?.ratification?.decisionEventId
  ) {
    addSectionHeading("3. Recorded Outcomes & Notes");
    if (proposal.implementationNote) {
      addKeyValueRow("Outcome / implementation", proposal.implementationNote);
    }
    if (proposal.supersededByProposalId) {
      addKeyValueRow(
        "Superseded by",
        `${proposal.supersededByProposalId}${proposal.supersededByNote ? ` — ${proposal.supersededByNote}` : ""}`,
      );
    }
    if (policyRecord?.ratification?.decisionEventId) {
      addKeyValueRow(
        "Ratification record",
        `${policyRecord.ratification.decisionEventId} (${formatDate(policyRecord.ratification.ratifiedAt)})`,
      );
    }
  }

  // Comments & deliberation
  addSectionHeading(`4. Member Comments & Deliberation (${comments.length})`);
  addWrappedParagraph(
    "Attribution shows display names as recorded in deliberation. Individual member votes, email addresses, and account identifiers are omitted to protect ballot secrecy and privacy.",
    { font: "F3", size: 8.5, leading: 12, color: "0.33 0.27 0.37" },
  );
  cursorY -= 4;

  if (comments.length === 0) {
    addWrappedParagraph("No member comments have been recorded for this proposal.", {
      font: "F1",
      size: 9.5,
      leading: 13.5,
      color: "0.33 0.27 0.37",
    });
  } else {
    for (let i = 0; i < comments.length; i++) {
      const comment = comments[i]!;
      const author = comment.authorName?.trim() || "Member";
      const header = `${i + 1}. ${author} · Stance: ${comment.stance} · ${formatDate(comment.createdAt)}`;
      ensureSpace(34);
      drawText(header, MARGIN_X, cursorY, {
        font: "F2",
        size: 9.5,
        color: "0.196 0.063 0.353",
      });
      cursorY -= 13;
      addWrappedParagraph(comment.body, {
        font: "F1",
        size: 9.5,
        leading: 13,
        x: MARGIN_X + 10,
        width: CONTENT_WIDTH - 10,
      });
      if (comment.feedback) {
        addWrappedParagraph(
          `Admin response (${comment.feedback.status}): ${comment.feedback.note || "Recorded"}${comment.feedback.updatedByName ? ` — ${comment.feedback.updatedByName}` : ""}`,
          {
            font: "F3",
            size: 8.5,
            leading: 12,
            color: "0.33 0.27 0.37",
            x: MARGIN_X + 10,
            width: CONTENT_WIDTH - 10,
          },
        );
      }
      cursorY -= 6;
    }
  }

  // Add running footers to every page
  const totalPages = pages.length;
  const generatedLabel = formatDate(generatedAt);
  for (let i = 0; i < totalPages; i++) {
    const pageLines = pages[i]!;
    const footerY = 28;
    pageLines.push(
      `0.87 0.84 0.91 RG 0.5 w ${MARGIN_X} ${(footerY + 11).toFixed(2)} m ${(PAGE_WIDTH - MARGIN_X).toFixed(2)} ${(footerY + 11).toFixed(2)} l S`,
    );
    pageLines.push(
      `BT 0.38 0.33 0.45 rg /F1 8 Tf 1 0 0 1 ${MARGIN_X} ${footerY} Tm ${pdfLiteral(`Engage Governance Report · ${proposal.proposalId} · ${scopeLabel} · Generated ${generatedLabel}`)} Tj ET`,
    );
    pageLines.push(
      `BT 0.38 0.33 0.45 rg /F1 8 Tf 1 0 0 1 ${(PAGE_WIDTH - MARGIN_X - 52).toFixed(2)} ${footerY} Tm ${pdfLiteral(`Page ${i + 1} of ${totalPages}`)} Tj ET`,
    );
  }

  // Assemble valid PDF 1.4 document with byte-accurate xref table
  const objects: string[] = [];
  // 1: Catalog, 2: Pages, 3: F1 Helvetica, 4: F2 Helvetica-Bold, 5: F3 Helvetica-Oblique
  const pageObjectIds: number[] = [];
  const baseObjId = 6;
  for (let i = 0; i < pages.length; i++) {
    const pageObjId = baseObjId + i * 2;
    pageObjectIds.push(pageObjId);
  }

  objects.push(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`);
  objects.push(
    `2 0 obj\n<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageObjectIds.length} >>\nendobj\n`,
  );
  objects.push(
    `3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n`,
  );
  objects.push(
    `4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>\nendobj\n`,
  );
  objects.push(
    `5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique /Encoding /WinAnsiEncoding >>\nendobj\n`,
  );

  for (let i = 0; i < pages.length; i++) {
    const pageObjId = baseObjId + i * 2;
    const contentObjId = pageObjId + 1;
    const stream = pages[i]!.join("\n");
    const streamBytes = Buffer.byteLength(stream, "latin1");
    objects.push(
      `${pageObjId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >> >> /Contents ${contentObjId} 0 R >>\nendobj\n`,
    );
    objects.push(
      `${contentObjId} 0 obj\n<< /Length ${streamBytes} >>\nstream\n${stream}\nendstream\nendobj\n`,
    );
  }

  const header = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
  const chunks: Buffer[] = [Buffer.from(header, "latin1")];
  const offsets: number[] = [0];
  let offset = chunks[0]!.length;

  for (const obj of objects) {
    offsets.push(offset);
    const buf = Buffer.from(obj, "latin1");
    chunks.push(buf);
    offset += buf.length;
  }

  const xrefOffset = offset;
  let xref = `xref\n0 ${offsets.length}\n`;
  xref += "0000000000 65535 f \n";
  for (let i = 1; i < offsets.length; i++) {
    xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  const trailer = `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  chunks.push(Buffer.from(xref + trailer, "latin1"));

  return new Uint8Array(Buffer.concat(chunks));
}
