import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { OPEN_BALLOT_EXPIRY_DEADLINE } from "./ballot-deadline.ts";
import {
  renderContributionResponseEmail,
  renderDigestEmail,
  renderMembershipNotificationEmail,
  renderMidPeriodReminderEmail,
  renderNewBallotEmail,
  renderReengagementEmail,
} from "./email-templates.ts";
import { renderVerification } from "./verification-email.ts";

const origin = "https://engage.fusionparty.org.au";
const unsub = `${origin}/api/email/unsubscribe?token=demo.token`;
const deadline = new Date(OPEN_BALLOT_EXPIRY_DEADLINE);

describe("responsive & accessible Engage email templates", () => {
  it("renders all 6 lifecycle email templates with Horizon branding, plain text, escaping, and unsubscribe links", () => {
    const digest = renderDigestEmail(
      '<img src=x onerror=alert(1)>',
      [
        {
          key: "k1",
          proposalId: "POL-1",
          title: '<script>bad</script> Clean Energy',
          href: "/proposals/clean-energy/#proposal-vote",
          closesAt: deadline,
          kind: "policy",
        },
      ],
      origin,
      unsub,
    );
    assert.match(digest.subject, /1 ballot closing soon/);
    assert.ok(!digest.html.includes("<script>bad</script>"));
    assert.ok(!digest.html.includes("<img src=x"));
    assert.match(digest.html, /Voting closes 14 January 2027/);
    assert.match(digest.html, /color-scheme/);
    assert.match(digest.html, /max-width:600px/);
    assert.match(digest.html, /engage-container/);
    assert.match(digest.text, /14 January 2027/);
    assert.match(digest.text, /Unsubscribe:/);

    const newBallot = renderNewBallotEmail(
      "Ethan",
      {
        title: "Digital Privacy Reform",
        summary: "Strengthen metadata protections.",
        href: "/proposals/digital-privacy/#proposal-vote",
        closesAt: deadline,
      },
      origin,
      unsub,
    );
    assert.match(newBallot.subject, /New ballot open/);
    assert.match(newBallot.html, /14 January 2027/);
    assert.match(newBallot.html, /never recommends how to vote/i);

    const midPeriod = renderMidPeriodReminderEmail(
      "Ethan",
      [
        {
          title: "Open Ballot 1",
          href: "/proposals/open-1/#proposal-vote",
          closesAt: deadline,
        },
      ],
      origin,
      unsub,
    );
    assert.match(midPeriod.subject, /1 open ballot awaiting your review/);
    assert.match(midPeriod.html, /Inspect ballot/);

    const reengage = renderReengagementEmail(
      "Ethan",
      [
        {
          title: "Housing Affordability",
          summary: "Review proposed policy commitments.",
          href: "/proposals/housing/",
          closesAt: deadline,
        },
      ],
      origin,
      unsub,
    );
    assert.match(reengage.subject, /Current proposals and ballots/);
    assert.match(reengage.html, /Browse open proposals/);

    const contrib = renderContributionResponseEmail(
      "Ethan",
      {
        proposalTitle: "Climate Action",
        status: "incorporated",
        note: "Added to Section 3.",
        href: "/proposals/climate/#deliberation",
      },
      origin,
      unsub,
    );
    assert.match(contrib.subject, /Response recorded/);
    assert.match(contrib.html, /incorporated/i);

    const membership = renderMembershipNotificationEmail(
      "Ethan",
      {
        heading: "Your membership is verified",
        summary: "You can now vote on national and branch ballots.",
        ctaLabel: "Open My Engage",
        href: "/member/",
      },
      origin,
    );
    assert.match(membership.subject, /Your membership is verified/);
    assert.match(membership.html, /Open My Engage/);

    const verification = renderVerification("Ethan", origin, true);
    for (const mail of [digest, newBallot, midPeriod, reengage, contrib, membership, verification]) {
      assert.doesNotMatch(mail.html, /horizon/i, "Email HTML must not expose internal Horizon design system name");
      assert.doesNotMatch(mail.text, /horizon/i, "Email text must not expose internal Horizon design system name");
      assert.match(mail.html, /FUSION PARTY AUSTRALIA/);
      assert.match(mail.html, /Engage/);
    }

    const manifest = readFileSync("public/manifest.webmanifest", "utf8");
    const sw = readFileSync("public/sw.js", "utf8");
    assert.doesNotMatch(manifest, /horizon/i);
    assert.doesNotMatch(sw, /horizon/i);
  });
});
