import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { OPEN_BALLOT_EXPIRY_DEADLINE } from "../src/lib/ballot-deadline.ts";
import {
  renderContributionResponseEmail,
  renderDigestEmail,
  renderMembershipNotificationEmail,
  renderMidPeriodReminderEmail,
  renderNewBallotEmail,
  renderReengagementEmail,
} from "../src/lib/email-templates.ts";

const outDir = resolve(
  process.argv[2] ??
    "/Users/ethan/.gemini/antigravity-cli/brain/e989f028-35d6-42c1-80e7-24d54504655f/scratch/email-previews",
);
mkdirSync(outDir, { recursive: true });

const origin = "https://engage.fusionparty.org.au";
const unsub = `${origin}/api/email/unsubscribe?token=preview.token`;
const deadline = new Date(OPEN_BALLOT_EXPIRY_DEADLINE);

const previews: Array<{ name: string; rendered: { subject: string; html: string; text: string } }> = [
  {
    name: "1-digest",
    rendered: renderDigestEmail(
      "Ethan",
      [
        {
          key: "k1",
          proposalId: "POL-1",
          title: "Clean Energy Transition Framework",
          href: "/proposals/clean-energy/#proposal-vote",
          closesAt: deadline,
          kind: "policy",
        },
      ],
      origin,
      unsub,
    ),
  },
  {
    name: "2-new-ballot",
    rendered: renderNewBallotEmail(
      "Ethan",
      {
        title: "Digital Privacy Reform",
        summary: "Strengthen metadata protections and warrant oversight.",
        href: "/proposals/digital-privacy/#proposal-vote",
        closesAt: deadline,
      },
      origin,
      unsub,
    ),
  },
  {
    name: "3-mid-period-reminder",
    rendered: renderMidPeriodReminderEmail(
      "Ethan",
      [
        {
          title: "Public Transport Electrification",
          href: "/proposals/public-transport/#proposal-vote",
          closesAt: deadline,
        },
      ],
      origin,
      unsub,
    ),
  },
  {
    name: "4-reengagement",
    rendered: renderReengagementEmail(
      "Ethan",
      [
        {
          title: "Housing Affordability Commitments",
          summary: "Review proposed policy commitments before voting closes.",
          href: "/proposals/housing/",
          closesAt: deadline,
        },
      ],
      origin,
      unsub,
    ),
  },
  {
    name: "5-contribution-response",
    rendered: renderContributionResponseEmail(
      "Ethan",
      {
        proposalTitle: "Clean Energy Transition Framework",
        href: "/proposals/clean-energy/#deliberation",
        status: "incorporated",
        note: "Updated Section 3 to clarify regional grid storage targets.",
      },
      origin,
      unsub,
    ),
  },
  {
    name: "6-membership-notification",
    rendered: renderMembershipNotificationEmail(
      "Ethan",
      {
        heading: "Branch membership verified",
        summary: "Your Victoria branch membership is now verified for branch-scoped ballots.",
        ctaLabel: "Open My Engage",
        href: "/member/",
      },
      origin,
    ),
  },
];

for (const item of previews) {
  writeFileSync(resolve(outDir, `${item.name}.html`), item.rendered.html, "utf8");
  writeFileSync(
    resolve(outDir, `${item.name}.txt`),
    `Subject: ${item.rendered.subject}\n\n${item.rendered.text}\n`,
    "utf8",
  );
}

console.log(`Generated ${previews.length} email previews in ${outDir}`);
