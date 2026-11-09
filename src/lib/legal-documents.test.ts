import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  legalDocuments,
  privacyPolicy,
  termsOfUse,
  type LegalBlock,
  type LegalDocument,
} from "../data/legal-documents.ts";

function textOf(document: LegalDocument): string {
  const parts = [
    document.title,
    document.description,
    document.operator,
    document.abn,
    document.registeredPartyName,
    document.registeredPartyAbbreviation,
    document.address,
    document.contact,
    document.status,
    document.effectiveDate,
    document.approval.status,
    document.approval.legalReview,
    document.approval.authorisedBy,
    ...document.approval.notes,
  ];

  for (const section of document.sections) {
    parts.push(section.title);
    for (const block of section.blocks) {
      parts.push(...blockText(block));
    }
  }

  return parts.join("\n");
}

function blockText(block: LegalBlock): string[] {
  if (block.type === "paragraph" || block.type === "subheading") {
    return [block.text];
  }
  if (block.type === "list") {
    return block.items;
  }
  if (block.type === "definitions") {
    return block.items.flatMap((item) => [item.term, item.description]);
  }
  if (block.type === "callout") {
    return [block.title, block.text];
  }
  return [];
}

function linksOf(text: string): Array<{ label: string; href: string }> {
  return [...text.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)].map((match) => ({
    label: match[1]!,
    href: match[2]!,
  }));
}

test("legal documents record owner authorisation without claiming legal review or publication", () => {
  for (const document of legalDocuments) {
    assert.equal(document.operator, "FUSION POLITICAL PARTY INCORPORATED");
    assert.equal(document.abn, "20 845 177 664");
    assert.equal(document.registeredPartyName, "votefusion.org for big ideas");
    assert.equal(document.registeredPartyAbbreviation, "votefusion.org");
    assert.equal(document.address, "254 McLeod Lane, Mansfield VIC 3722");
    assert.equal(document.contact, "contact@fusionparty.org.au");
    assert.equal(document.publicationStatus, "owner-authorised");
    assert.equal(document.status, "Owner authorised · publication pending");
    assert.match(document.effectiveDate, /^To be set by the release owner/);
    assert.match(document.approval.status, /Owner authorisation recorded/);
    assert.match(document.approval.status, /publication approval/i);
    assert.match(document.approval.legalReview, /Not completed/);
    assert.match(document.approval.authorisedBy, /Owner authorisation confirmed/);
    assert.match(
      document.approval.authorisedBy,
      /formal publication approving office-holder and approval date are not recorded/,
    );
    const text = textOf(document);
    assert.match(text, /FUSION POLITICAL PARTY INCORPORATED/);
    assert.match(text, /votefusion\.org for big ideas/);
    assert.match(text, /votefusion\.org/);
    assert.match(text, /254 McLeod Lane, Mansfield VIC 3722/);
    assert.match(text, /contact@fusionparty\.org\.au/);
  }
});

test("privacy policy covers the implemented data practices and sensitive information", () => {
  const text = textOf(privacyPolicy);
  const ids = new Set(privacyPolicy.sections.map((section) => section.id));

  for (const id of [
    "about",
    "information-we-collect",
    "political-sensitive-information",
    "why-we-use-information",
    "who-can-see-information",
    "disclosure",
    "overseas",
    "security",
    "retention",
    "access-correction-deletion",
    "cookies",
    "changes",
    "contact",
    "legal-framework",
  ]) {
    assert.ok(ids.has(id), `privacy policy should have section ${id}`);
  }

  assert.match(text, /political opinions/i);
  assert.match(text, /membership of a political party/i);
  assert.match(text, /sensitive information/i);
  assert.match(text, /national administrators can identify how you voted/i);
  assert.match(text, /not describe voting as anonymous or secret/i);
  assert.match(text, /optional reason/i);
  assert.match(text, /Google/);
  assert.match(text, /Resend/);
  assert.match(text, /self-hosted/i);
  assert.match(text, /Account deletion is not currently self-service/i);
  assert.match(text, /Privacy Act 1988/);
  assert.match(text, /OAIC/);
  assert.match(text, /server logs/i);
  assert.match(text, /governance record/i);
});

test("privacy policy describes aggregate analytics without claiming anonymous voting", () => {
  const text = textOf(privacyPolicy);

  assert.doesNotMatch(text, /votes? (are|is) anonymous/i);
  assert.doesNotMatch(text, /secret ballot/i);
  assert.match(text, /Fusion-hosted Plausible Analytics/i);
  assert.match(text, /ballot choices or reasons/i);
  assert.match(text, /query strings and fragments are removed/i);
});

test("terms cover participation, content, voting, records and disputes", () => {
  const text = textOf(termsOfUse);
  const ids = new Set(termsOfUse.sections.map((section) => section.id));

  for (const id of [
    "operator",
    "these-terms",
    "public-browsing",
    "accounts",
    "conduct",
    "your-content",
    "proposals",
    "voting",
    "results",
    "moderation",
    "records",
    "availability",
    "privacy",
    "changes",
    "governance",
    "disputes",
  ]) {
    assert.ok(ids.has(id), `terms should have section ${id}`);
  }

  assert.match(text, /you retain ownership/i);
  assert.match(text, /Nothing in these terms transfers your copyright/i);
  assert.match(text, /Australian Consumer Law/);
  assert.match(text, /Constitution/);
  assert.match(text, /Code of Conduct/);
  assert.match(text, /Dispute Resolution/);
  assert.match(text, /voting is not anonymous/i);
  assert.match(text, /national administrators can identify/i);
  assert.match(text, /Seconding formal motions is not yet implemented/i);
  assert.match(text, /A successful vote is not adoption/i);
  assert.match(text, /cannot be edited or deleted through the application/i);
  assert.match(text, /Do not coerce, buy or trade votes/i);
  assert.match(text, /laws of Victoria, Australia/i);
  assert.match(text, /votefusion.org for big ideas/i);
});

test("terms distinguish legitimate public access from abusive automation", () => {
  const text = textOf(termsOfUse);

  assert.match(text, /reasonable indexing of public pages not marked noindex/i);
  assert.match(text, /accessibility tools/i);
  assert.match(text, /limited research access to public governance information/i);
  assert.match(text, /excessive, disruptive, bypasses access controls or collects personal information without consent/i);
  assert.match(text, /Pages marked noindex should not be indexed/i);
  assert.doesNotMatch(
    text,
    /scrape, crawl or automate access without Fusion's written permission/i,
  );
});

test("terms do not treat public browsing as affirmative acceptance", () => {
  const text = textOf(termsOfUse);

  assert.match(text, /does not treat merely viewing a public page as affirmative acceptance/i);
  assert.match(text, /Acceptance mechanism is implemented but not active/i);
  assert.match(text, /intentionally inactive until these documents are published/i);
  assert.match(text, /Public browsing alone is not treated as acceptance/i);
});

test("terms describe ballot intervention capabilities without inventing a contingency policy", () => {
  const text = textOf(termsOfUse);

  assert.match(text, /technical controls that can close a ballot or change its stage/i);
  assert.match(text, /not a complete contingency policy/i);
  assert.match(
    text,
    /grounds, approval requirements, member notice and escalation steps/i,
  );
  assert.match(text, /Outstanding governance decision/i);
  assert.doesNotMatch(text, /unrestricted discretion/i);
});

test("legal documents use unique section IDs and safe links", () => {
  for (const document of legalDocuments) {
    const ids = document.sections.map((section) => section.id);
    assert.equal(new Set(ids).size, ids.length, `${document.slug} section IDs`);

    for (const section of document.sections) {
      assert.ok(section.blocks.length > 0, `${section.id} should have content`);
    }

    const text = textOf(document);
    for (const link of linksOf(text)) {
      assert.match(
        link.href,
        /^(\/|https:\/\/|mailto:)/,
        `${document.slug} link ${link.href} must be relative, HTTPS or mailto`,
      );
      assert.doesNotMatch(link.href, /javascript:/i);
      if (link.href.startsWith("/")) {
        assert.match(link.href, /\/$/, "internal links should use trailing slash");
      }
    }

    assert.doesNotMatch(text, /\b(TODO|TBD|FIXME)\b/);
    const emails = [
      ...text.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi),
    ].map((match) => match[0].toLowerCase());
    assert.deepEqual(
      [...new Set(emails)],
      ["contact@fusionparty.org.au"],
      "only the approved contact email may appear in public legal copy",
    );
    assert.doesNotMatch(
      text,
      /memberId|ObjectId|MONGODB_URI|RESEND_API_KEY|GOOGLE_CLIENT_SECRET/,
      "public legal copy must not expose implementation identifiers",
    );
  }
});

test("legal pages delegate to the shared renderer and add no tracking", () => {
  const sources = [
    readFileSync(new URL("../pages/privacy/index.astro", import.meta.url), "utf8"),
    readFileSync(new URL("../pages/terms/index.astro", import.meta.url), "utf8"),
    readFileSync(
      new URL("../components/legal/LegalDocument.astro", import.meta.url),
      "utf8",
    ),
  ];

  for (const source of sources) {
    assert.doesNotMatch(
      source,
      /plausible|google analytics|gtag|posthog|umami|matomo/i,
    );
  }

  assert.match(sources[0]!, /LegalDocument/);
  assert.match(sources[1]!, /LegalDocument/);
  assert.match(sources[0]!, /prerender = false/);
  assert.match(sources[1]!, /prerender = false/);
  assert.match(sources[2]!, /noIndex/);
});

