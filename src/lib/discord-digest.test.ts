import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createMemoryDb } from "./db.ts";
import { updateDiscordSettings } from "./discord-settings.ts";
import {
  attentionScore,
  melbourneWeekKey,
  renderDiscordDigest,
  renderDiscordDigestText,
  runWeeklyDiscordDigest,
  selectDiscordDigest,
  sendTestDiscordDigest,
  validateDiscordWebhook,
  type DigestCandidate,
} from "./discord-digest.ts";

const NOW = new Date("2026-11-16T09:00:00.000Z");
const ORIGIN = "https://engage.fusionparty.org.au";
const SECRET = "test-development-secret-key-at-least-32-bytes";
const FAKE_WEBHOOK = "https://discord.com/api/webhooks/123456789012345678/testSecretToken";
const FAKE_TEST_WEBHOOK = "https://discord.com/api/webhooks/234567890123456789/testServerToken";

function candidate(id: number, extras: Partial<DigestCandidate> = {}): DigestCandidate {
  return {
    proposalId: `P-${id}`,
    slug: `topic-${id}`,
    title: `Proposal ${id}`,
    stage: id % 2 ? "deliberate" : "decide",
    createdAt: new Date("2026-11-01T00:00:00Z"),
    commentCount: 0,
    participation: 0,
    closesAt: new Date("2027-01-14T13:00:00Z"),
    exposures: 0,
    lastFeaturedAt: null,
    ...extras,
  };
}

describe("Discord Attention Debt selection", () => {
  it("does not rank the simultaneous launch cohort using legacy creation dates", () => {
    const oldProposal = candidate(1, { createdAt: new Date("2021-01-01") });
    const newProposal = candidate(1, { createdAt: new Date("2026-11-15") });
    assert.equal(attentionScore(oldProposal, NOW), attentionScore(newProposal, NOW));
  });

  it("prioritises genuine low engagement while treating unknown ballot turnout as unknown", () => {
    assert.ok(attentionScore(candidate(1), NOW) > attentionScore(candidate(1, { commentCount: 20 }), NOW));
    assert.ok(attentionScore(candidate(2, { participation: 0 }), NOW) >
      attentionScore(candidate(2, { participation: 60 }), NOW));
    assert.ok(attentionScore(candidate(2, { participation: 0 }), NOW) >
      attentionScore(candidate(2, { participation: null }), NOW));
  });

  it("discounts repeat exposure and a recent feature without excluding proposals forever", () => {
    const fresh = candidate(1);
    const exposed = candidate(1, { exposures: 2, lastFeaturedAt: NOW });
    assert.ok(attentionScore(fresh, NOW) > attentionScore(exposed, NOW));
    assert.ok(attentionScore(candidate(1, {
      exposures: 2,
      lastFeaturedAt: new Date(NOW.getTime() - 18 * 86_400_000),
    }), NOW) > attentionScore(exposed, NOW));
  });

  it("uses reproducible exploration with bounded, distinct and balanced slots", () => {
    const pool = Array.from({ length: 40 }, (_, i) =>
      candidate(i + 1, { commentCount: i % 8, participation: i % 8 }),
    );
    const first = selectDiscordDigest(pool, NOW);
    const second = selectDiscordDigest([...pool].reverse(), NOW);
    assert.deepEqual(first.map((c) => c.proposalId), second.map((c) => c.proposalId));
    assert.equal(first.length, 5);
    assert.equal(new Set(first.map((c) => c.proposalId)).size, 5);
    assert.ok(first.filter((c) => c.stage === "deliberate").length >= 2);
    assert.ok(first.filter((c) => c.stage === "decide").length >= 2);
  });

  it("excludes closed ballots and never selects outside the supplied public pool", () => {
    const closed = candidate(2, { closesAt: new Date("2026-11-01T00:00:00Z") });
    const selected = selectDiscordDigest([candidate(1), closed], NOW);
    assert.deepEqual(selected.map((c) => c.proposalId), ["P-1"]);
  });

  it("uses Melbourne's calendar week across daylight saving and local Sunday/Monday", () => {
    assert.equal(melbourneWeekKey(new Date("2026-11-15T12:00:00Z")), "2026-11-09");
    assert.equal(melbourneWeekKey(new Date("2026-11-15T13:01:00Z")), "2026-11-16");
    assert.equal(melbourneWeekKey(new Date("2027-01-03T13:01:00Z")), "2027-01-04");
  });
});

describe("Discord webhook delivery safety", () => {
  it("accepts Discord webhooks only and refuses external hosts, credentials and query strings", () => {
    assert.equal(validateDiscordWebhook(FAKE_WEBHOOK).hostname, "discord.com");
    for (const bad of [
      "https://evil.example/api/webhooks/123456789012345678/secret",
      "http://discord.com/api/webhooks/123456789012345678/secret",
      "https://discord.com.evil.example/api/webhooks/123456789012345678/secret",
      `${FAKE_WEBHOOK}?thread_id=123`,
      "https://user:password@discord.com/api/webhooks/123456789012345678/secret",
    ]) assert.throws(() => validateDiscordWebhook(bad));
  });

  it("escapes untrusted proposal titles and mentions only the configured role", () => {
    const ranked = selectDiscordDigest([
      candidate(1, { title: "@everyone **Now** <@&555555555555555555>" }),
    ], NOW);
    const message = renderDiscordDigest(ranked, ORIGIN, "123456789012345678", true);
    const embed = message.embeds[0]!;
    assert.match(embed.title, /^TEST — Engage this week$/);
    assert.equal(embed.color, 0x00c9d2);
    assert.equal(message.content, "<@&123456789012345678>");
    assert.equal(embed.fields?.length, 1);
    assert.match(embed.fields![0]!.name, /^Discussion · /);
    assert.match(embed.fields![0]!.value, /source=discord-weekly/);
    const serialised = JSON.stringify(message.embeds);
    assert.doesNotMatch(serialised, /@everyone/);
    assert.doesNotMatch(serialised, /\*\*Now\*\*/);
    assert.doesNotMatch(serialised, /<@&555555555555555555>/);
  });

  it("posts a single embed with a linked field for every featured proposal", () => {
    const ranked = selectDiscordDigest([
      candidate(1, { title: "A discussion", commentCount: 2 }),
      candidate(2, { title: "A ballot", participation: 7 }),
    ], NOW);
    const message = renderDiscordDigest(ranked, ORIGIN);
    const embed = message.embeds[0]!;
    assert.equal(message.embeds.length, 1);
    assert.equal(message.content, "");
    assert.equal(embed.url, ORIGIN);
    assert.equal(embed.fields?.length, 2);
    const discussion = embed.fields!.find((f) => f.name.startsWith("Discussion ·"))!;
    const ballot = embed.fields!.find((f) => f.name.startsWith("Open vote ·"))!;
    assert.match(discussion.value, /2 contributions so far/);
    assert.match(discussion.value, /#deliberation/);
    assert.match(ballot.value, /7 participants so far/);
    assert.match(ballot.value, /#proposal-vote/);
    assert.match(embed.footer!.text, /read each proposal/i);
  });

  it("renders an empty state and an explicit test label without fields", () => {
    const message = renderDiscordDigest([], ORIGIN, undefined, true);
    assert.match(message.embeds[0]!.title, /^TEST/);
    assert.equal(message.embeds[0]!.fields, undefined);
    assert.match(message.embeds[0]!.description!, /Nothing currently needs a spotlight/);
    assert.match(message.embeds[0]!.footer!.text, /Test post/);
    assert.match(renderDiscordDigestText(message), /TEST — Engage this week/);
  });

  it("uses the isolated test webhook and records a one-minute dedupe; live remains disabled", async () => {
    const db = createMemoryDb();
    await db.collection("proposals").insertOne({
      proposalId: "P-1",
      slug: "testing-engage",
      title: "Test proposal",
      space: "Participation",
      summary: "Sample",
      outcomes: [],
      details: "Sample",
      stage: "deliberate",
      publicationScope: "national",
      createdAt: new Date("2026-11-01"),
      updatedAt: NOW,
    });
    const calls: Array<{ url: string; payload: Record<string, any> }> = [];
    const send = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        payload: JSON.parse(String(init?.body)),
      });
      return Response.json({ id: "345678901234567890" });
    };
    const env = {
      PUBLIC_ORIGIN: ORIGIN,
      BETTER_AUTH_SECRET: SECRET,
    };
    await updateDiscordSettings(db, env, { memberId: "admin", name: "Admin" }, {
      testWebhookUrl: FAKE_TEST_WEBHOOK,
      testRoleId: "456789012345678901",
    });
    assert.deepEqual(
      await runWeeklyDiscordDigest(db, env, send as typeof fetch, NOW),
      { status: "disabled", featured: 0 },
    );
    const first = await sendTestDiscordDigest(db, env, "admin", send as typeof fetch, NOW);
    const again = await sendTestDiscordDigest(db, env, "admin", send as typeof fetch, NOW);
    assert.deepEqual(first, { status: "sent", featured: 1 });
    assert.deepEqual(again, { status: "already-attempted", featured: 0 });
    assert.equal(calls.length, 1);
    assert.ok(calls[0]!.url.startsWith(FAKE_TEST_WEBHOOK));
    assert.match(calls[0]!.payload.embeds[0].title, /^TEST/);
    assert.equal(calls[0]!.payload.content, "<@&456789012345678901>");
    assert.deepEqual(calls[0]!.payload.allowed_mentions, {
      parse: [],
      roles: ["456789012345678901"],
    });
    const rows = await db.collection("discord_digest_runs").find({ kind: "test" }).toArray();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.status, "sent");
  });

  it("holds an ambiguous test send and does not automatically try again", async () => {
    const db = createMemoryDb();
    const env = {
      PUBLIC_ORIGIN: ORIGIN,
      BETTER_AUTH_SECRET: SECRET,
    };
    await updateDiscordSettings(db, env, { memberId: "admin", name: "Admin" }, {
      testWebhookUrl: FAKE_TEST_WEBHOOK,
    });
    const failure = async () => { throw new Error("network lost"); };
    const result = await sendTestDiscordDigest(db, env, "admin", failure as typeof fetch, NOW);
    assert.equal(result.status, "held");
    assert.equal(
      (await sendTestDiscordDigest(db, env, "admin", failure as typeof fetch, NOW)).status,
      "already-attempted",
    );
  });
});
