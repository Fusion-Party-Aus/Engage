# Historical Engage participation communications: consent and eligibility assessment

Assessed 9 November 2026. Scope: one-time restoration of access/discoverability and relevant Engage participation reminders for existing members. General campaigning, fundraising, merchandise, newsletters and unrelated services are outside this assessment. This assessment does not authorise a send or declare all historical members consented.

## Finding

**Missing notification preferences are not an opt-out.** Existing Engage accounts can be retained in the legacy opt-out cohort without fabricating an express-consent record. A narrowly relevant member-participation communication has a plausible inferred-consent basis where the member knowingly provided the address and has a provable ongoing membership/account relationship. That is an inference requiring evidence of the actual relationship and expected purpose; a database record or silence alone is not enough to establish it universally.

Historical source supports the purpose of membership verification and participation. It does not prove what every person saw, the membership terms under which their address was collected, or consent to indefinite recurring emails. Therefore unassessed legacy candidates appear in **needs review**, with their legacy status preserved. They are neither marked opted out nor discarded for lacking a consent field that did not exist.

## Australian framework checked

- [Spam Act 2003, current Federal Register entry](https://www.legislation.gov.au/C2004A01214/latest), Schedule 2 clause 2: consent includes express consent and reasonable inference from conduct and relationships. Section 6 assesses commercial purpose from the message, presentation and linked content. Classify the actual proposed email and its destinations, not just its 'participation' label.
- [ACMA, Avoid sending spam](https://www.acma.gov.au/avoid-sending-spam): inferred consent can arise from a provable ongoing relationship with directly relevant communication. Keep evidence; identify the authorising sender; provide clear, functional unsubscribe controls. Where applicable, act on unsubscribe within five working days and keep the mechanism usable for at least 30 days. Do not assume a marketing request for consent can itself be sent without a basis.
- [ACMA, Dealing with spam](https://www.acma.gov.au/dealing-with-spam): registered political parties have an exemption, with sender-identification obligations remaining. The precise statutory designated-message conditions in Schedule 1 should be checked against the sender/content.
- [Department of Infrastructure, Unwanted communications](https://www.infrastructure.gov.au/media-communications-arts/phone/unwanted-communications) confirms the political-party exception to consent/unsubscribe requirements for applicable commercial messages, with sender identification retained. A narrow non-commercial internal participation notice may not be a commercial message in the first place. Neither finding is a reason to override recorded opt-outs or delivery suppressions.

Before relying on a political-party exception, establish the actual authorising entity and current relevant registration, including any national/branch distinction. This implementation does not assume registration from the Fusion name, or treat a state branch as independently registered. No exemption is enabled automatically.

These are alternative potential bases, not interchangeable consent records. An exemption is not express consent. A reviewed inferred basis is not a retrospective checkbox. Any future campaign must retain its applicable assessment and actual copy/audience for review.

## Historical disclosure evidence inspected

| Evidence | What it supports | Limit |
| --- | --- | --- |
| `src/pages/member/index.astro` at `bacd10e47e1c4f24ce894d171ffdf8b4a1693ec5` (24 October 2026) | Sign-in followed by authorised party-membership verification; participation after approval | No recurring digest consent statement found |
| Same file at `c8f957fe318d9057f666f415e836975e5cd3f63b` (7 November 2026) | Member voluntarily provides name/address, requests email sign-in, expects verification and participation | Asking for a sign-in email does not itself prove recurring email consent |
| `src/data/legal-documents.ts` at `33cc170871db058b47a6cad3f0bc9f88f15d19a1` (7 November 2026) | Describes membership checks and Resend sign-in/verification notices | Distinguishes Engage from older main-site/member-mailing notices; does not establish historical recurring-digest consent |
| Merged digest cohort/preferences at `3dc0f7661feac1ac2969b413bc3260e13dc6f0fa` | Immutable existing-account snapshot, defaults and category-specific member choices | Cohort membership establishes legacy status, not by itself a legal basis |

Repository history is not proof of deployment or of individual exposure/acceptance. Original party membership forms, their collection disclosures, deployment dates and continued relationship evidence were not available. No production cohort has been approved by this assessment. The owner can review those facts without requiring members to supply impossible historical preference records.

## Implemented rules

| Recorded Engage state | Treatment |
| --- | --- |
| Explicit opt-in | Candidate if ordinary lifecycle/delivery checks pass; general-newsletter permission irrelevant |
| Explicit opt-out or effective Engage unsubscribe | Excluded; no inferred basis or exemption overrides the product opt-out |
| Legacy, no recorded Engage choice | Retained as legacy candidate. Review applicable basis; a documented, current scoped assessment can qualify the cohort/member without inventing express consent |
| Suppressed: bounce, complaint or delivery restriction | Suppressed regardless of preference or basis |
| New account, no opt-in | Optional participation digests remain off; needs explicit opt-in |
| Legacy cohort cannot be established | Needs review; missing snapshot is not interpreted as a new-account refusal |

Other filters remain: verified membership, enabled/proven address, no prior participation, historical verification window, activity recency, notice-delivery uncertainty. Unknown verification dates also remain visible in needs-review counts rather than being silently excluded. General communications preferences do not control this Engage-specific audience.

The default read-only report includes consent-state totals, eligible/excluded/suppressed/needs-review totals, exclusion/review reasons, and whether a legacy snapshot exists. National administrators can add `include=members` to the preview URL to inspect member IDs, per-member consent states and reasons before approving an audience; no addresses or voting choices are returned and this detail never enters Plausible. It never changes live preferences, captures a new cohort, records inferred consent, or sends messages.

## Documenting a reviewed basis

The preview recognises existing `engagement_consent_assessments` records with `scope: engage-participation`, `status: approved`, a reviewer/time, a future expiry, nonempty evidence references and one basis: `inferred-membership`, `non-commercial-participation` or `registered-party-exemption`. Records must target an individual member or the fixed `ballot-reminders-v1` rollout cohort. A cohort record does not expand to new accounts. Expired/incomplete/unreviewed records never make a legacy audience eligible.

Evidence should identify the reviewed collection disclosures/deployment period, ongoing membership basis, authorising entity, message purpose and sender/linked-content assessment as applicable. Evidence references must be references to genuine retained assessment material, not an invented timestamp or assertion that 'no opt-out means consent'. No live assessment records were written by this change, and there is no API that marks a basis approved automatically.

Eligibility does not equal send approval: every report retains `campaignApprovalRequired: true`; there is no historical campaign sender. Review the real audience and message, including clear sender contact information and digest unsubscribe controls, then obtain the owner's explicit campaign approval. Leave legally uncertain cases on hold while retaining them in the reviewable audience.

## Preserved member controls

The agreed existing-account digest default remains opt-out, subject to the relevant lawful basis before sending. New accounts explicitly opt in in onboarding. My Engage → Notifications shows the preference state and independently controls account notifications, Engage participation emails and general communications. Existing digest unsubscribe (including one-click POST) and suppression infrastructure is reused. Turning off newsletters does not turn off Engage participation, and turning off Engage does not alter general/newsletter settings.
