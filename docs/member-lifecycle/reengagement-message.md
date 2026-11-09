# Proposed one-time Engage participation message — DRAFT, NOT SENT

Audience: the reviewed and explicitly approved historical audience from the read-only preview. Purpose: restore a known member's route into Engage participation. This is optional Engage participation communication, not a transactional backfill or a general campaign/newsletter. Do not send to opt-outs, suppressions or legally uncertain cases.

Subject: **Your Engage account is ready when you are**

Hello {{ member_name_or_member }},

You have a verified Engage account. You can take part in ballots where you meet the eligibility requirements, and My Engage shows what’s available to you.

We’ve improved My Engage so you can find your next step, see ballots awaiting your vote and follow your previous participation. If there are no eligible ballots open, you can explore proposals and come back when a ballot opens.

**[Open My Engage](https://engage.fusionparty.org.au/member/)**

If you’re asked to sign in, use the email address associated with your Engage account. You can also use your existing Google sign-in or passkey.

Keep this address handy: **https://engage.fusionparty.org.au/member/**

You can choose your Engage participation emails in **My Engage → Notifications**. These settings are separate from general party newsletters and campaigning.

{{ preference_explanation }}

[Manage Engage preferences](https://engage.fusionparty.org.au/member/?view=notifications) · [Unsubscribe from Engage participation emails]({{ signed_engage_unsubscribe_url }})

Fusion Party Australia · {{ confirmed_authorising_sender_and_contact_details }}

## Rendering and approval notes

- Reuse the existing Horizon digest shell, plain-text alternative and signed Engage-category unsubscribe mechanism; do not create another scheduler or mailing list.
- For explicit opt-in: `You receive this participation message because you enabled Engage emails. You can unsubscribe at any time.`
- For a reviewed legacy basis: `Your account predates Engage’s email preferences. Relevant Engage participation emails use an existing-account opt-out setting where permitted. You can turn them off here or in My Engage at any time.` This explains a default; it must not claim the member explicitly subscribed.
- Use the canonical configured production origin when rendering. Never personalise links with member IDs, addresses, vote choices or other sensitive data for analytics. A signed unsubscribe token is for preference control only and must never enter Plausible.
- Include the actual authorising sender's confirmed contact details. Check the final copy and linked content against the recorded legal assessment, especially if relying on non-commercial purpose or a political-party exception.
- Generate a fresh detailed dry-run audience immediately before review. Attach the approval to that audience, copy version and one-time campaign identity. Recheck opt-outs and suppressions at dispatch; any future sender needs a durable per-campaign/member claim and provider receipts. There is no sender implemented by this change.
