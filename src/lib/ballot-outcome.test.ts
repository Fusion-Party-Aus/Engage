import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import {
  BALLOT_OUTCOME_RULE_BASIS,
  ballotOutcomeLabel,
  computeBallotOutcome,
  loadBallotTallyCryptoConfig,
  resolveBallotClosure,
  sumVoteTally,
} from "./ballots.ts";
import { generateBallotKeyHex } from "./ballot-crypto.ts";
import {
  ballotResultPayload,
  formStatusRegion,
  syncBallotOutcomeOverride,
} from "./ballot-outcome-form.ts";

// The computed rule is deliberately narrow: D9 supplies simple majority, D10/O1
// leaves the abstention denominator undefined, and D8 supplies no quorum. These
// cases pin the comparison without inventing a rule.

test("simple majority approves only when Yes is greater than No (D9)", () => {
  assert.equal(computeBallotOutcome({ approve: 5, reject: 3 }), "successful");
  assert.equal(computeBallotOutcome({ approve: 4, reject: 5 }), "unsuccessful");
});

test("a tie does not approve (D9)", () => {
  assert.equal(computeBallotOutcome({ approve: 4, reject: 4 }), "unsuccessful");
});

test("zero votes are not successful", () => {
  assert.equal(computeBallotOutcome({ approve: 0, reject: 0 }), "unsuccessful");
});

test("abstentions never change the Yes-versus-No comparison (D10/O1)", () => {
  // No denominator is used: a large abstain count cannot dilute approval,
  // and it cannot rescue rejection.
  assert.equal(computeBallotOutcome({ approve: 2, reject: 1 }), "successful");
  assert.equal(computeBallotOutcome({ approve: 1, reject: 2 }), "unsuccessful");
});

test("the rule basis is versioned", () => {
  assert.equal(BALLOT_OUTCOME_RULE_BASIS, "simple-majority-d9-v1");
});

test("summing stored choices keeps abstentions in the tally but out of the comparison", () => {
  const tally = sumVoteTally([
    "approve",
    "approve",
    "reject",
    "abstain",
    "abstain",
  ]);
  assert.deepEqual(tally, {
    approve: 2,
    abstain: 2,
    reject: 1,
    total: 5,
  });
  assert.equal(computeBallotOutcome(tally), "successful");
});

test("an unreadable choice fails rather than being counted as a rejection", () => {
  assert.throws(
    () => sumVoteTally(["approve", "maybe" as never]),
    /could not be read/,
  );
});

// The result forms reveal the override reason only when the chosen outcome
// contradicts the computed one. These stubs pin the browser contract without a
// DOM; the server still enforces the same rule.
function stubResultForm(value: string, computed: string) {
  const field = { hidden: true };
  const reason = {
    required: false,
    value: "stale text",
    focused: false,
    focus() {
      this.focused = true;
    },
  };
  const announcement = { textContent: "" };
  const select = { value };
  const form = {
    dataset: { computedResult: computed, proposalId: "PROP-1" },
    querySelector: (selector: string) => {
      if (selector.startsWith("select")) return select;
      if (selector.startsWith("[data-override-field]")) return field;
      if (selector.startsWith("[data-override-announcement]")) return announcement;
      if (selector.startsWith("textarea")) return reason;
      return null;
    },
  };
  return { form: form as unknown as HTMLFormElement, field, reason, announcement };
}

test("the override reason is required only for a contradicting outcome", () => {
  const matching = stubResultForm("successful", "successful");
  syncBallotOutcomeOverride(matching.form);
  assert.equal(matching.field.hidden, true);
  assert.equal(matching.reason.required, false);
  assert.equal(matching.reason.value, "");

  const contradicting = stubResultForm("unsuccessful", "successful");
  syncBallotOutcomeOverride(contradicting.form, { focus: true });
  assert.equal(contradicting.field.hidden, false);
  assert.equal(contradicting.reason.required, true);
  assert.equal(contradicting.reason.focused, true);
  assert.match(contradicting.announcement.textContent, /written reason is required/i);

  const unchosen = stubResultForm("", "successful");
  syncBallotOutcomeOverride(unchosen.form);
  assert.equal(unchosen.field.hidden, true);
  assert.equal(unchosen.reason.required, false);
  assert.equal(unchosen.announcement.textContent, "");

  // inconclusive can never equal a computed outcome, so it always asks for a reason.
  const inconclusive = stubResultForm("inconclusive", "unsuccessful");
  syncBallotOutcomeOverride(inconclusive.form);
  assert.equal(inconclusive.field.hidden, false);
  assert.equal(inconclusive.reason.required, true);
});

test("the submitted payload carries an override reason only when one is written", () => {
  const fields = new Map<string, string>([
    ["result", "unsuccessful"],
    ["decisionEventId", "BALLOT-1"],
    ["overrideReason", "  Officer review.  "],
  ]);
  const fakeFields = { get: (key: string) => fields.get(key) ?? null };
  const form = {
    dataset: { proposalId: "PROP-1" },
  } as unknown as HTMLFormElement;

  assert.deepEqual(ballotResultPayload(form, fakeFields), {
    proposalId: "PROP-1",
    result: "unsuccessful",
    decisionEventId: "BALLOT-1",
    overrideReason: "Officer review.",
  });

  fields.delete("overrideReason");
  assert.deepEqual(ballotResultPayload(form, fakeFields), {
    proposalId: "PROP-1",
    result: "unsuccessful",
    decisionEventId: "BALLOT-1",
  });
});

test("the submit handler targets the visible status line, not the hidden announcement", () => {
  const visible = { id: "visible" };
  const hidden = { id: "hidden" };
  const form = {
    querySelector: (selector: string) => {
      // The hidden announcement is the first [role="status"] node in the form.
      if (selector === '[role="status"]') return hidden;
      if (selector === ".admin-status[role='status']") return visible;
      return null;
    },
  } as unknown as HTMLFormElement;

  assert.equal(formStatusRegion(form), visible);
  assert.notEqual(formStatusRegion(form), hidden);
});

test("the workspace result form keeps the announcement out of the status lookup", () => {
  const workspace = readFileSync(
    new URL("../pages/admin/proposals/[slug].astro", import.meta.url),
    "utf8",
  );

  assert.match(workspace, /data-override-announcement aria-live="polite"/);
  assert.doesNotMatch(workspace, /data-override-announcement role="status"/);
  assert.match(workspace, /const status = formStatusRegion\(form\);/);
});

test("the register keeps the list read vote-free and loads tallies on demand for inline outcome recording", () => {
  // The register list read remains vote-free (no readBoundBallotTallies on SSR);
  // opening a row's inline outcome disclosure fetches /api/admin/proposals/ballot-tally
  // on demand before revealing the ballot-result-form.
  const register = readFileSync(
    new URL("../pages/admin/proposals/index.astro", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(register, /readBoundBallotTallies/);
  assert.match(register, /listProposalRegister/);
  assert.match(register, /class="ballot-result-form/);
  assert.match(register, /\/api\/admin\/proposals\/ballot-tally/);
  assert.match(register, /data-override-announcement aria-live="polite"/);
  assert.doesNotMatch(register, /data-override-announcement role="status"/);
});

test("display key loading degrades to null instead of throwing", () => {
  // Missing keys with encryption enabled make the strict loader throw.
  assert.equal(
    loadBallotTallyCryptoConfig({ BALLOT_ENCRYPTION_MODE: "encrypt" }),
    null,
  );
  assert.equal(loadBallotTallyCryptoConfig({}), null);

  const config = loadBallotTallyCryptoConfig({
    BALLOT_ENCRYPTION_MODE: "encrypt",
    BALLOT_ENCRYPTION_KEYS: `v1:${generateBallotKeyHex()}`,
    BALLOT_BLIND_INDEX_KEY: `bi-v1:${generateBallotKeyHex()}`,
  });
  assert.ok(config);
  assert.equal(config?.mode, "encrypt");
});

test("outcome labels are title case for every recorded and computed value", () => {
  assert.equal(ballotOutcomeLabel("successful"), "Successful");
  assert.equal(ballotOutcomeLabel("unsuccessful"), "Unsuccessful");
  assert.equal(ballotOutcomeLabel("inconclusive"), "Inconclusive");
  assert.equal(ballotOutcomeLabel(undefined), "Not recorded");
});

test("closure state follows the ballot row before the matter", () => {
  const now = new Date("2026-11-15T00:00:00Z");
  const future = new Date("2026-11-20T00:00:00Z");
  const past = new Date("2026-11-10T00:00:00Z");

  // A live ballot on a closed matter is not certifiable.
  assert.deepEqual(
    resolveBallotClosure({
      ballot: { status: "open", closesAt: future },
      matter: { ballotClosedAt: now },
      now,
    }),
    { closed: false, closesAt: future, basis: "ballot" },
  );

  // A closed status wins even without a close time.
  assert.deepEqual(
    resolveBallotClosure({
      ballot: { status: "closed" },
      matter: { ballotClosesAt: future },
      now,
    }),
    { closed: true, basis: "ballot" },
  );

  // A ballot close time that has passed is closed.
  assert.deepEqual(
    resolveBallotClosure({
      ballot: { status: "open", closesAt: past },
      matter: null,
      now,
    }),
    { closed: true, closesAt: past, basis: "ballot" },
  );

  // Legacy ballots fall back to the matter.
  assert.deepEqual(
    resolveBallotClosure({
      ballot: null,
      matter: { ballotClosedAt: past },
      now,
    }),
    { closed: true, basis: "matter" },
  );
  assert.deepEqual(
    resolveBallotClosure({
      ballot: { status: "open" },
      matter: { ballotClosesAt: future },
      now,
    }),
    { closed: false, closesAt: future, basis: "matter" },
  );
  assert.deepEqual(resolveBallotClosure({ now }), {
    closed: false,
    basis: "none",
  });
});
