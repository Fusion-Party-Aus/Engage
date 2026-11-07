import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createMemoryDb } from "./db.ts";
import {
  buildLegalAcceptanceManifest,
  hasCurrentLegalAcceptance,
  legalAcceptanceStatus,
  legalDocumentHash,
  LegalAcceptanceError,
  recordLegalAcceptance,
  requireLegalAcceptance,
} from "./legal-acceptance.ts";
import { privacyPolicy, termsOfUse } from "../data/legal-documents.ts";

const publishedTerms = {
  ...termsOfUse,
  publicationStatus: "published" as const,
  effectiveDate: "10 November 2026",
};
const publishedPrivacy = {
  ...privacyPolicy,
  publicationStatus: "published" as const,
  effectiveDate: "10 November 2026",
};
const activeEnv = { LEGAL_ACCEPTANCE_ENABLED: "true" };
const manifest = buildLegalAcceptanceManifest(
  activeEnv,
  publishedTerms,
  publishedPrivacy,
);

test("legal acceptance stays inactive until publication and the flag align", () => {
  assert.equal(
    buildLegalAcceptanceManifest({}, publishedTerms, publishedPrivacy).enabled,
    false,
  );
  assert.equal(
    buildLegalAcceptanceManifest(
      activeEnv,
      termsOfUse,
      publishedPrivacy,
    ).enabled,
    false,
  );
  assert.equal(
    buildLegalAcceptanceManifest(
      activeEnv,
      publishedTerms,
      privacyPolicy,
    ).enabled,
    false,
  );
  assert.equal(
    buildLegalAcceptanceManifest(
      activeEnv,
      { ...publishedTerms, effectiveDate: "To be set on publication" },
      publishedPrivacy,
    ).enabled,
    false,
  );
  assert.equal(manifest.enabled, true);

  assert.equal(
    buildLegalAcceptanceManifest({ LEGAL_ACCEPTANCE_ENABLED: "true" }).enabled,
    false,
    "the repository documents must remain owner-authorised, not published",
  );
});

test("legal document hashes change when the operative version changes", () => {
  const original = legalDocumentHash(publishedTerms);
  const changed = legalDocumentHash({
    ...publishedTerms,
    version: "1.1",
  });
  assert.match(original, /^[a-f0-9]{64}$/);
  assert.notEqual(original, changed);
});

test("acceptance records the versions, hashes, member and timestamp", async () => {
  const db = createMemoryDb();
  const acceptedAt = new Date("2026-11-10T01:00:00.000Z");

  const record = await recordLegalAcceptance(db, {
    memberId: "member-1",
    termsAccepted: true,
    privacyAcknowledged: true,
    manifest,
    acceptedAt,
  });

  assert.equal(record.memberId, "member-1");
  assert.equal(record.termsVersion, manifest.termsVersion);
  assert.equal(record.termsHash, manifest.termsHash);
  assert.equal(record.privacyVersion, manifest.privacyVersion);
  assert.equal(record.privacyHash, manifest.privacyHash);
  assert.equal(record.termsAccepted, true);
  assert.equal(record.privacyAcknowledged, true);
  assert.equal(record.acceptedAt.toISOString(), acceptedAt.toISOString());
});

test("acceptance is idempotent for the same member and document versions", async () => {
  const db = createMemoryDb();
  const first = await recordLegalAcceptance(db, {
    memberId: "member-1",
    termsAccepted: true,
    privacyAcknowledged: true,
    manifest,
    acceptedAt: new Date("2026-11-10T01:00:00.000Z"),
  });
  const second = await recordLegalAcceptance(db, {
    memberId: "member-1",
    termsAccepted: true,
    privacyAcknowledged: true,
    manifest,
    acceptedAt: new Date("2026-11-11T01:00:00.000Z"),
  });

  assert.equal(second.acceptanceId, first.acceptanceId);
  assert.equal(
    second.acceptedAt.toISOString(),
    first.acceptedAt.toISOString(),
    "a repeat submission must not rewrite the original acceptance time",
  );
  assert.equal(
    await db.collection("legal_acceptances").countDocuments({}),
    1,
  );
});

test("acceptance requires both affirmative actions and an active gate", async () => {
  const db = createMemoryDb();

  await assert.rejects(
    recordLegalAcceptance(db, {
      memberId: "member-1",
      termsAccepted: false,
      privacyAcknowledged: true,
      manifest,
    }),
    (error: unknown) =>
      error instanceof LegalAcceptanceError &&
      error.code === "LEGAL_ACCEPTANCE_INCOMPLETE",
  );

  await assert.rejects(
    recordLegalAcceptance(db, {
      memberId: "member-1",
      termsAccepted: true,
      privacyAcknowledged: false,
      manifest,
    }),
    (error: unknown) =>
      error instanceof LegalAcceptanceError &&
      error.code === "LEGAL_ACCEPTANCE_INCOMPLETE",
  );

  const inactive = buildLegalAcceptanceManifest(
    {},
    publishedTerms,
    publishedPrivacy,
  );
  await assert.rejects(
    recordLegalAcceptance(db, {
      memberId: "member-1",
      termsAccepted: true,
      privacyAcknowledged: true,
      manifest: inactive,
    }),
    (error: unknown) =>
      error instanceof LegalAcceptanceError &&
      error.code === "LEGAL_ACCEPTANCE_NOT_ACTIVE",
  );

  assert.equal(
    await db.collection("legal_acceptances").countDocuments({}),
    0,
  );
});

test("participation is blocked until the current versions are accepted", async () => {
  const db = createMemoryDb();
  const user = { memberId: "member-1" };

  const blocked = await requireLegalAcceptance(db, user, activeEnv, manifest);
  assert.equal(blocked?.status, 403);
  assert.equal(
    ((await blocked?.json()) as { code?: string }).code,
    "LEGAL_ACCEPTANCE_REQUIRED",
  );

  await recordLegalAcceptance(db, {
    memberId: user.memberId,
    termsAccepted: true,
    privacyAcknowledged: true,
    manifest,
  });

  assert.equal(
    await requireLegalAcceptance(db, user, activeEnv, manifest),
    null,
  );
  assert.equal(await hasCurrentLegalAcceptance(db, user.memberId, manifest), true);

  const nextVersion = buildLegalAcceptanceManifest(
    activeEnv,
    { ...publishedTerms, version: "1.1" },
    publishedPrivacy,
  );
  assert.equal(
    (await requireLegalAcceptance(db, user, activeEnv, nextVersion))?.status,
    403,
    "a new terms version must require fresh acceptance",
  );
});

test("acceptance status describes the active gate and links", async () => {
  const db = createMemoryDb();
  const before = await legalAcceptanceStatus(db, "member-1", manifest);

  assert.equal(before.enabled, true);
  assert.equal(before.accepted, false);
  assert.equal(before.required, true);
  assert.equal(before.terms.href, "/terms/");
  assert.equal(before.privacy.href, "/privacy/");

  await recordLegalAcceptance(db, {
    memberId: "member-1",
    termsAccepted: true,
    privacyAcknowledged: true,
    manifest,
  });

  const after = await legalAcceptanceStatus(db, "member-1", manifest);
  assert.equal(after.accepted, true);
  assert.equal(after.required, false);
});

test("participation APIs enforce acceptance server-side", () => {
  const endpoints = [
    "../pages/api/votes.ts",
    "../pages/api/comments.ts",
    "../pages/api/proposals/index.ts",
    "../pages/api/proposals/[proposalId].ts",
    "../pages/api/amendments.ts",
  ];

  for (const endpoint of endpoints) {
    const source = readFileSync(new URL(endpoint, import.meta.url), "utf8");
    assert.match(source, /requireLegalAcceptance/, `${endpoint} must import the gate`);
    assert.match(
      source,
      /const gate = await requireLegalAcceptance\(db, user, env\);\s*\n\s*if \(gate\) return gate;/,
      `${endpoint} must return the gate response before writing`,
    );
  }

  const proposalPage = readFileSync(
    new URL("../pages/proposals/[slug].astro", import.meta.url),
    "utf8",
  );
  assert.match(proposalPage, /BallotPrivacyNotice/);
});

test("the acceptance API and gate do not enable themselves or add tracking", () => {
  const api = readFileSync(
    new URL("../pages/api/legal/acceptance.ts", import.meta.url),
    "utf8",
  );
  const gate = readFileSync(
    new URL("../components/legal/LegalAcceptanceGate.astro", import.meta.url),
    "utf8",
  );
  const member = readFileSync(
    new URL("../pages/member/index.astro", import.meta.url),
    "utf8",
  );
  const ballotNotice = readFileSync(
    new URL("../components/legal/BallotPrivacyNotice.astro", import.meta.url),
    "utf8",
  );

  assert.match(api, /LEGAL_ACCEPTANCE_NOT_ACTIVE/);
  assert.match(api, /termsAccepted/);
  assert.match(api, /privacyAcknowledged/);
  assert.match(api, /recordLegalAcceptance/);

  assert.match(gate, /\/api\/legal\/acceptance/);
  assert.match(gate, /href="\/terms\/"/);
  assert.match(gate, /href="\/privacy\/"/);
  assert.match(gate, /name="termsAccepted"/);
  assert.match(gate, /name="privacyAcknowledged"/);
  assert.match(gate, /not a substitute for/);

  assert.match(member, /LegalAcceptanceGate/);
  assert.match(member, /Member participation is subject to the/);
  assert.match(member, /href="\/terms\/"/);
  assert.match(member, /href="\/privacy\/"/);
  assert.doesNotMatch(member, /By signing in, you agree/);

  assert.match(ballotNotice, /identifiable to national administrators/i);
  assert.match(ballotNotice, /href="\/privacy\/"/);
  assert.match(ballotNotice, /very small ballot/i);

  for (const source of [api, gate, member, ballotNotice]) {
    assert.doesNotMatch(source, /plausible|google analytics|gtag|posthog|umami|matomo/i);
  }
});
