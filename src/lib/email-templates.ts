import {
  ballotDeadlineDateLabel,
  ballotDeadlineLabel,
} from "./ballot-deadline.ts";

export const escapeEmailHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (c) =>
    ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[c]!,
  );

export interface RenderedEmail {
  subject: string;
  previewText: string;
  text: string;
  html: string;
}

export interface EmailLayoutOptions {
  title: string;
  previewText: string;
  heading: string;
  greeting: string;
  intro: string;
  bodyHtml: string;
  bodyText: string;
  footerReason: string;
  origin: string;
  unsubscribeUrl?: string;
  unsubscribeLabel?: string;
  testBanner?: string;
}

function buildUrl(origin: string, href: string, source: string): string {
  const url = new URL(href, origin);
  if (!url.searchParams.has("source")) {
    url.searchParams.set("source", source);
  }
  return url.href;
}

/**
 * Shared Horizon-branded, email-client-compatible layout (Gmail, Apple Mail,
 * Outlook, dark mode & blocked-image safe).
 */
export function renderEmailLayout(opts: EmailLayoutOptions): {
  previewText: string;
  text: string;
  html: string;
} {
  const e = escapeEmailHtml;
  const preferencesUrl = `${opts.origin}/member/?view=notifications`;
  const memberHomeUrl = `${opts.origin}/member/`;

  const bannerHtml = opts.testBanner
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px 0;">
        <tr>
          <td style="padding:12px 16px;background-color:#fcf0d5;border:1px solid #e7c88a;border-radius:8px;color:#593b06;font-size:14px;line-height:1.5;">
            <strong>Test email — sample data only.</strong> ${e(opts.testBanner)}
          </td>
        </tr>
      </table>`
    : "";

  const unsubscribeHtml = opts.unsubscribeUrl
    ? ` &middot; <a href="${e(opts.unsubscribeUrl)}" style="color:#32105a;text-decoration:underline;">${e(opts.unsubscribeLabel ?? "Unsubscribe from reminders")}</a>`
    : "";

  const html = `<!doctype html>
<html lang="en-AU" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <meta name="color-scheme" content="light dark" />
  <meta name="supported-color-schemes" content="light dark" />
  <title>${e(opts.title)}</title>
  <style>
    @media only screen and (max-width: 620px) {
      .engage-container { width: 100% !important; border-radius: 0 !important; }
      .engage-pad { padding: 20px 18px !important; }
      .engage-h1 { font-size: 26px !important; }
      .engage-btn { display: block !important; text-align: center !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;background-color:#f2eef9;color:#271047;font-family:Outfit,-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;-webkit-text-size-adjust:100%;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${e(opts.previewText)}&#847; &#847; &#847;</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f2eef9;">
    <tr>
      <td align="center" style="padding:24px 12px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" class="engage-container" style="width:100%;max-width:600px;background-color:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #ded6e7;">
          <tr>
            <td class="engage-pad" style="background-color:#32105a;color:#ffffff;padding:24px 28px;border-bottom:6px solid #00c9d2;">
              <p style="margin:0;font-size:11px;font-weight:700;letter-spacing:2.4px;text-transform:uppercase;color:#d6c7ea;">FUSION PARTY AUSTRALIA</p>
              <p style="margin:6px 0 0;font-family:Newsreader,Georgia,'Times New Roman',serif;font-size:32px;font-weight:600;line-height:1.1;color:#ffffff;">Engage</p>
            </td>
          </tr>
          <tr>
            <td class="engage-pad" style="padding:28px;">
              ${bannerHtml}
              <h1 class="engage-h1" style="margin:0 0 16px;font-family:Newsreader,Georgia,'Times New Roman',serif;font-size:28px;font-weight:600;line-height:1.2;color:#271047;">${e(opts.heading)}</h1>
              <p style="margin:0 0 12px;font-size:16px;line-height:1.6;color:#271047;">${e(opts.greeting)}</p>
              <p style="margin:0 0 20px;font-size:16px;line-height:1.6;color:#271047;">${e(opts.intro)}</p>
              ${opts.bodyHtml}
              <p style="margin:24px 0 8px;font-size:14px;line-height:1.6;color:#54465f;">Voting and participation are optional. Review the exact wording and member discussion before deciding—Engage never recommends how to vote.</p>
              <p style="margin:12px 0 0;font-size:15px;line-height:1.6;"><a href="${e(memberHomeUrl)}" style="color:#32105a;font-weight:600;text-decoration:underline;">Open My Engage →</a></p>
            </td>
          </tr>
          <tr>
            <td class="engage-pad" style="padding:20px 28px;background-color:#f8f5fc;border-top:1px solid #ded6e7;font-size:12px;line-height:1.65;color:#54465f;">
              <strong style="color:#271047;">Fusion Party Australia · Engage</strong><br />
              ${e(opts.footerReason)}<br />
              <a href="${e(preferencesUrl)}" style="color:#32105a;text-decoration:underline;">Notification preferences</a>${unsubscribeHtml}<br />
              Changing Engage reminder settings affects participation digests only; account security and membership records are separate.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const textParts = [
    opts.testBanner ? `TEST EMAIL (sample data only): ${opts.testBanner}\n` : "",
    opts.greeting,
    "",
    opts.intro,
    "",
    opts.bodyText,
    "",
    `My Engage: ${memberHomeUrl}`,
    `Notification preferences: ${preferencesUrl}`,
    opts.unsubscribeUrl ? `Unsubscribe: ${opts.unsubscribeUrl}` : "",
    "",
    opts.footerReason,
    "Voting and participation are optional; review the exact wording before deciding.",
  ].filter((part, idx, arr) => !(part === "" && arr[idx - 1] === ""));

  return {
    previewText: opts.previewText,
    text: textParts.join("\n"),
    html,
  };
}

export type DigestBallotItem = {
  key: string;
  title: string;
  href: string;
  closesAt: Date;
  proposalId: string;
  kind?: string;
};

/** 1. Ballot closing-soon digest */
export function renderDigestEmail(
  name: string,
  ballots: DigestBallotItem[],
  origin: string,
  unsubscribeUrl: string,
  existingDefault = false,
): RenderedEmail {
  const e = escapeEmailHtml;
  const count = ballots.length;
  const subject = `Engage: ${count} ballot${count === 1 ? "" : "s"} closing soon`;
  const previewText =
    count === 1 && ballots[0]
      ? `${ballots[0].title} closes ${ballotDeadlineDateLabel(ballots[0].closesAt)}.`
      : `${count} eligible ballots close within seven days.`;

  const footerReason = existingDefault
    ? "Ballot reminders were enabled for your existing Engage account. You can turn them off at any time."
    : "You receive this because you enabled Engage ballot reminders.";

  const bodyHtml = ballots
    .map((b) => {
      const ctaHref = buildUrl(origin, b.href, "digest");
      const kindLabel =
        b.kind === "resolution" ? "Governance resolution" : "Policy proposal";
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 14px;border:1px solid #ded6e7;border-radius:10px;background-color:#faf8fd;">
        <tr>
          <td style="padding:18px 20px;">
            <p style="margin:0 0 6px;font-size:12px;font-weight:600;letter-spacing:0.6px;text-transform:uppercase;color:#54465f;">${e(kindLabel)}</p>
            <h2 style="margin:0 0 8px;font-family:Newsreader,Georgia,'Times New Roman',serif;font-size:21px;font-weight:600;line-height:1.25;color:#271047;">${e(b.title)}</h2>
            <p style="margin:0 0 14px;font-size:14px;line-height:1.5;color:#271047;"><strong>Voting closes ${e(ballotDeadlineDateLabel(b.closesAt))}</strong><br /><span style="color:#54465f;font-size:13px;">${e(ballotDeadlineLabel(b.closesAt))}</span></p>
            <a class="engage-btn" href="${e(ctaHref)}" style="display:inline-block;background-color:#00c9d2;color:#271047;padding:11px 20px;border-radius:999px;font-size:14px;font-weight:700;text-decoration:none;">Read the wording &amp; vote →</a>
          </td>
        </tr>
      </table>`;
    })
    .join("");

  const bodyText = ballots
    .map(
      (b) =>
        `${b.title}\nVoting closes ${ballotDeadlineLabel(b.closesAt)}\n${buildUrl(origin, b.href, "digest")}`,
    )
    .join("\n\n");

  const layout = renderEmailLayout({
    title: subject,
    previewText,
    heading:
      count === 1
        ? "One ballot closes soon."
        : `${count} ballots close within seven days.`,
    greeting: `Hello ${name || "member"},`,
    intro:
      count === 1
        ? "This eligible ballot closes within seven days and does not yet have your vote."
        : `These ${count} eligible ballots close within seven days and do not yet have your vote.`,
    bodyHtml,
    bodyText,
    footerReason,
    origin,
    unsubscribeUrl,
  });

  return { subject, ...layout };
}

/** 2. New ballot announcement */
export function renderNewBallotEmail(
  name: string,
  ballot: {
    title: string;
    summary: string;
    href: string;
    closesAt?: Date | null;
    kind?: string;
  },
  origin: string,
  unsubscribeUrl: string,
): RenderedEmail {
  const e = escapeEmailHtml;
  const ctaHref = buildUrl(origin, ballot.href, "new-ballot");
  const subject = `Engage: New ballot open — ${ballot.title}`;
  const previewText = ballot.closesAt
    ? `Voting is open until ${ballotDeadlineDateLabel(ballot.closesAt)}.`
    : "A new formal ballot is open for your review.";
  const deadlineLine = ballot.closesAt
    ? `Voting closes ${ballotDeadlineDateLabel(ballot.closesAt)} (${ballotDeadlineLabel(ballot.closesAt)})`
    : "Check the proposal page for the closing schedule.";

  const bodyHtml = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #ded6e7;border-radius:10px;background-color:#faf8fd;">
    <tr>
      <td style="padding:20px;">
        <h2 style="margin:0 0 8px;font-family:Newsreader,Georgia,'Times New Roman',serif;font-size:22px;line-height:1.25;color:#271047;">${e(ballot.title)}</h2>
        <p style="margin:0 0 12px;font-size:15px;line-height:1.6;color:#271047;">${e(ballot.summary)}</p>
        <p style="margin:0 0 16px;font-size:14px;line-height:1.5;color:#54465f;">${e(deadlineLine)}</p>
        <a class="engage-btn" href="${e(ctaHref)}" style="display:inline-block;background-color:#00c9d2;color:#271047;padding:11px 20px;border-radius:999px;font-size:14px;font-weight:700;text-decoration:none;">Review wording &amp; vote →</a>
      </td>
    </tr>
  </table>`;

  const layout = renderEmailLayout({
    title: subject,
    previewText,
    heading: "A new ballot is open.",
    greeting: `Hello ${name || "member"},`,
    intro:
      "A formal ballot you are eligible to vote on is now open in Engage. Discussion and formal voting are separate—you can read both before deciding.",
    bodyHtml,
    bodyText: `${ballot.title}\n${ballot.summary}\n${deadlineLine}\n${ctaHref}`,
    footerReason:
      "You receive this because new ballot notifications are enabled in your Engage preferences.",
    origin,
    unsubscribeUrl,
  });

  return { subject, ...layout };
}

/** 3. Mid-period participation reminder */
export function renderMidPeriodReminderEmail(
  name: string,
  ballots: Array<{ title: string; href: string; closesAt?: Date | null }>,
  origin: string,
  unsubscribeUrl: string,
): RenderedEmail {
  const e = escapeEmailHtml;
  const count = ballots.length;
  const subject = `Engage: ${count} open ballot${count === 1 ? "" : "s"} awaiting your review`;
  const previewText = `You have ${count} open ballot${count === 1 ? "" : "s"} you haven't voted on yet.`;

  const bodyHtml = ballots
    .map((b) => {
      const ctaHref = buildUrl(origin, b.href, "mid-period");
      const closing = b.closesAt
        ? `Voting closes ${ballotDeadlineDateLabel(b.closesAt)}`
        : "Currently open";
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 12px;border:1px solid #ded6e7;border-radius:10px;background-color:#faf8fd;">
        <tr>
          <td style="padding:16px 18px;">
            <h2 style="margin:0 0 6px;font-family:Newsreader,Georgia,'Times New Roman',serif;font-size:20px;line-height:1.25;color:#271047;">${e(b.title)}</h2>
            <p style="margin:0 0 12px;font-size:14px;color:#54465f;">${e(closing)}</p>
            <a class="engage-btn" href="${e(ctaHref)}" style="display:inline-block;background-color:#32105a;color:#ffffff;padding:10px 18px;border-radius:999px;font-size:14px;font-weight:600;text-decoration:none;">Inspect ballot →</a>
          </td>
        </tr>
      </table>`;
    })
    .join("");

  const bodyText = ballots
    .map((b) => {
      const closing = b.closesAt
        ? `Voting closes ${ballotDeadlineLabel(b.closesAt)}`
        : "Currently open";
      return `${b.title}\n${closing}\n${buildUrl(origin, b.href, "mid-period")}`;
    })
    .join("\n\n");

  const layout = renderEmailLayout({
    title: subject,
    previewText,
    heading: "Open ballots waiting for your review.",
    greeting: `Hello ${name || "member"},`,
    intro:
      "Here is a single mid-period summary of eligible ballots currently open on Engage.",
    bodyHtml,
    bodyText,
    footerReason:
      "You receive this because Engage participation reminders are enabled in your preferences.",
    origin,
    unsubscribeUrl,
  });

  return { subject, ...layout };
}

/** 4. Re-engagement email */
export function renderReengagementEmail(
  name: string,
  opportunities: Array<{ title: string; summary: string; href: string; closesAt?: Date | null }>,
  origin: string,
  unsubscribeUrl: string,
): RenderedEmail {
  const e = escapeEmailHtml;
  const subject = "Engage: Current proposals and ballots open for members";
  const previewText =
    "Catch up on open proposals and formal ballots in Engage whenever it suits you.";

  const itemsHtml = opportunities
    .slice(0, 3)
    .map((item) => {
      const ctaHref = buildUrl(origin, item.href, "reengagement");
      const closing = item.closesAt
        ? `Voting closes ${ballotDeadlineDateLabel(item.closesAt)}`
        : "Open for discussion";
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 12px;border:1px solid #ded6e7;border-radius:10px;background-color:#faf8fd;">
        <tr>
          <td style="padding:16px 18px;">
            <h2 style="margin:0 0 6px;font-family:Newsreader,Georgia,'Times New Roman',serif;font-size:19px;line-height:1.25;color:#271047;">${e(item.title)}</h2>
            <p style="margin:0 0 8px;font-size:14px;line-height:1.5;color:#271047;">${e(item.summary)}</p>
            <p style="margin:0 0 10px;font-size:13px;color:#54465f;">${e(closing)}</p>
            <a href="${e(ctaHref)}" style="color:#32105a;font-size:14px;font-weight:700;text-decoration:underline;">View on Engage →</a>
          </td>
        </tr>
      </table>`;
    })
    .join("");

  const exploreUrl = buildUrl(origin, "/proposals/", "reengagement");
  const bodyHtml = `${itemsHtml}
    <p style="margin:18px 0 0;">
      <a class="engage-btn" href="${e(exploreUrl)}" style="display:inline-block;background-color:#00c9d2;color:#271047;padding:12px 22px;border-radius:999px;font-size:14px;font-weight:700;text-decoration:none;">Browse open proposals →</a>
    </p>`;

  const bodyText = [
    ...opportunities
      .slice(0, 3)
      .map(
        (item) =>
          `${item.title}\n${item.summary}\n${buildUrl(origin, item.href, "reengagement")}`,
      ),
    `Browse all proposals: ${exploreUrl}`,
  ].join("\n\n");

  const layout = renderEmailLayout({
    title: subject,
    previewText,
    heading: "What members are reviewing on Engage.",
    greeting: `Hello ${name || "member"},`,
    intro:
      "Your Engage membership is active. If you have a few minutes this week, here are current proposals and ballots open for member input.",
    bodyHtml,
    bodyText,
    footerReason:
      "You received this one-off participation update because your Engage membership is verified and you have not opted out of Engage emails.",
    origin,
    unsubscribeUrl,
  });

  return { subject, ...layout };
}

/** 5. Contribution response notification */
export function renderContributionResponseEmail(
  name: string,
  contribution: {
    proposalTitle: string;
    status: string;
    note?: string;
    href: string;
  },
  origin: string,
  unsubscribeUrl: string,
): RenderedEmail {
  const e = escapeEmailHtml;
  const ctaHref = buildUrl(origin, contribution.href, "contribution-response");
  const subject = `Engage: Response recorded on "${contribution.proposalTitle}"`;
  const previewText = `Your contribution was marked "${contribution.status}".`;

  const bodyHtml = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #ded6e7;border-radius:10px;background-color:#faf8fd;">
    <tr>
      <td style="padding:18px 20px;">
        <p style="margin:0 0 6px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.6px;color:#32105a;">Outcome: ${e(contribution.status)}</p>
        <h2 style="margin:0 0 10px;font-family:Newsreader,Georgia,'Times New Roman',serif;font-size:21px;line-height:1.25;color:#271047;">${e(contribution.proposalTitle)}</h2>
        ${contribution.note ? `<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#271047;">${e(contribution.note)}</p>` : ""}
        <a class="engage-btn" href="${e(ctaHref)}" style="display:inline-block;background-color:#00c9d2;color:#271047;padding:11px 20px;border-radius:999px;font-size:14px;font-weight:700;text-decoration:none;">View contribution outcome →</a>
      </td>
    </tr>
  </table>`;

  const layout = renderEmailLayout({
    title: subject,
    previewText,
    heading: "Your contribution received a response.",
    greeting: `Hello ${name || "member"},`,
    intro:
      "A proposal author or governance officer recorded an outcome on your deliberation contribution.",
    bodyHtml,
    bodyText: `${contribution.proposalTitle}\nOutcome: ${contribution.status}${contribution.note ? `\nNote: ${contribution.note}` : ""}\n${ctaHref}`,
    footerReason:
      "You receive this because contribution response notifications are enabled in your Engage preferences.",
    origin,
    unsubscribeUrl,
  });

  return { subject, ...layout };
}

/** 6. Membership / account notification */
export function renderMembershipNotificationEmail(
  name: string,
  notice: {
    heading: string;
    summary: string;
    ctaLabel: string;
    href: string;
  },
  origin: string,
): RenderedEmail {
  const e = escapeEmailHtml;
  const ctaHref = buildUrl(origin, notice.href, "account-notice");
  const subject = `Engage: ${notice.heading}`;

  const bodyHtml = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #ded6e7;border-radius:10px;background-color:#faf8fd;">
    <tr>
      <td style="padding:18px 20px;">
        <p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#271047;">${e(notice.summary)}</p>
        <a class="engage-btn" href="${e(ctaHref)}" style="display:inline-block;background-color:#32105a;color:#ffffff;padding:11px 20px;border-radius:999px;font-size:14px;font-weight:600;text-decoration:none;">${e(notice.ctaLabel)} →</a>
      </td>
    </tr>
  </table>`;

  const layout = renderEmailLayout({
    title: subject,
    previewText: notice.summary,
    heading: notice.heading,
    greeting: `Hello ${name || "member"},`,
    intro: "Here is an update about your Engage membership and participation access.",
    bodyHtml,
    bodyText: `${notice.summary}\n${ctaHref}`,
    footerReason:
      "You receive this as an essential Engage account and membership notification.",
    origin,
  });

  return { subject, ...layout };
}
