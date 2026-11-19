# Community Mosaic verification

**Document status: Current.** Evidence for the redesign on `Policy_Group_Consultation`, 20 November 2026 (Australia/Sydney). Source baseline: `59453ade3e244665d036607e8fd3f7c2f2a24639`.

This record accompanies the [implementation, route and journey inventory](community-mosaic-redesign.md). It distinguishes application test results from the limitations of the local host and synthetic fixtures. It is not a production security certification.

## Environment and isolation

- Node 24.22.3; repository-pinned pnpm 10.28.0 with a frozen lockfile.
- Playwright 1.57.0, matching the existing CI harness version; official Chrome for Testing headless shell 143.0.7499.192.
- Browser tooling is installed outside the repository. No application dependency or lockfile change was needed.
- Every preview uses explicit local origins, synthetic accounts and an environment allowlist. Production credentials and MongoDB configuration are not inherited.
- External browser requests are blocked or satisfied by explicit test fixtures. No production member, CRM, email, Turnstile or voting operation was performed. Local vote mutations used synthetic accounts and disposable in-memory data.
- Baseline screenshots were captured from an unchanged archive of the starting commit, without checking out or modifying another development branch.

## Core checks

| Check | Observed result |
|---|---|
| Frozen dependency installation | Passed with pnpm 10.28.0; package manifest and lockfile unchanged |
| Astro/TypeScript check | Passed on 466 files: 0 errors, 0 warnings, 33 hints |
| Node suite | 892 tests: **836 passed, 0 failed, 56 skipped**, 114 suites |
| Local real MongoDB tests | The 56 database-dependent tests were skipped, not passed. MongoDB 8 could not initialise CPU discovery in this host; MongoDB 7 was blocked before opening a listener. No production URI was substituted. |
| Production application build | Passed; existing dynamic-import and Shiki/CSP warnings retained without weakening CSP |
| Build without `.git` | Passed from a separate source snapshot; the changelog generator retained the existing history snapshot rather than fabricating history |
| Documentation links | Checked with `scripts/check-doc-links.mjs` |
| Whitespace/diff check | `git diff --check` passed |
| Primitive/token audit | No non-primitive raw controls or newly undefined global CSS variables in changed source files |
| Protected source audit | No changes to backend modules, API endpoints, auth/RBAC, database code, dependencies, lockfile, Astro configuration, Docker or GitHub workflows |

The local Node result is deliberately not described as 892 passing tests. Real MongoDB evidence must come from an isolated replica set, such as the repository's existing Application checks job.

## Existing browser suites

The following existing harnesses passed against the redesigned build:

| Harness | Coverage preserved |
|---|---|
| `member-lifecycle-browser.mjs` | Desktop/mobile visitor, pending, verified, branch and member journeys; guest voting intent, sign-in return, account and member navigation |
| `security-perimeter-browser.mjs` | Security headers/CSP and origin restrictions, public forms and sign-in integration fixtures |
| `discussion-thread-browser.mjs` | Discussion threads, reply and moderation-related behaviour |
| `member-profile-browser.mjs` | Public profile, visibility, account and contribution boundaries |
| `sense-box-amendments-browser.mjs` | Public contribution, consent/status and amendment workflows |

The lifecycle harness was adapted to open the existing bookmark disclosure and to review a vote before confirmation. Other existing browser assertions were retained. The standalone proposal-experience and RFC governance scripts were updated for the same reviewed-vote sequence, but are not listed as locally executed real-Mongo governance suites.

## Focused ballot regression

`scripts/ballot-review-browser.mjs` passed at 1440 × 1000 and 390 × 844, with zero page errors, no horizontal overflow and no external requests.

Verified behaviour:

- Fresh choices are unselected; a prior guest draft is restored without submitting.
- Sign-in return preserves the explicit selection.
- Review makes no vote request, moves focus appropriately and preserves choice/reason when edited.
- Rejection preserves the draft; successful record, update and reason-only update go through the actual isolated application API.
- Duplicate synchronous clicks cause one POST; payload fields remain exactly `proposalId`, `choice`, `reason`.
- Share removes query parameters and fragment and cannot hide an uncertain-submission warning.
- An ambiguous response disables repeated submission until reload retrieves the recorded state.
- Expiry during review removes confirmation without another POST.
- Explicit response mocks verify that pending verification stays pending, the returned choice is honoured and a later pending reason cannot replace the reason attached to an earlier formal vote.

The pending and changed-membership cases are labelled response mocks. They verify UI interpretation; they do not prove real membership promotion or MongoDB concurrency.

## Visual and route checks

The reusable `scripts/theme-visual-browser.mjs` captures actual desktop, tablet and mobile pages, verifies the final URL, checks the administrator shell where required, records broken images, horizontal overflow, browser errors and response failures, and reports fixture gaps honestly. It also exports native viewport captures and records selected image and bundle sizes.

The public suite contains 36 route/viewport cases. All 36 reached the expected route with no horizontal overflow, broken image or uncaught JavaScript error. Its strict result is 33/36 because the three member-dashboard widths reproduce the same baseline passkey-list endpoint 503 in the no-Mongo preview. That pre-existing limitation is retained in the report instead of being suppressed.

The administrator suite passed all 42 available cases: 18 seeded administrator pages at 390px and 1440px, plus three permission states at both widths. The invitation-detail and Sense Box administrator-detail records have no seeded instance in this read-only scanner and are reported as unavailable, not as successes. Their source routes remain in the full coverage inventory; the existing contribution suite exercises the related submission workflow. The administrator scanner exits nonzero for these two unavailable records even though all 42 executed cases pass.

The five existing browser suites passed on the earlier consolidated redesign candidate. The full 36 public/member cases and 42 administrator/permission cases were compared against the 16:06 UTC candidate. After the responsive-image refinements, targeted home and Sense Box checks passed on the 16:18 UTC candidate. Focused keyboard and text-resize results identify their final candidate separately; these are not claimed as a second complete run of all 78 cases.

The first exploratory administrator capture used an incorrect synthetic cookie value and followed a sign-in redirect. Those images were discarded as admin evidence. The final harness uses the correct administrator actor and asserts the final route and shell. Permission checks use the application's real contract: ordinary members receive the existing 403 overview, and a forbidden settings request redirects to that overview.

A headless full-page screenshot option initially omitted composited photo layers. Normal viewport/element captures displayed the images correctly, and removing the animation-disabling capture option made the full-page and viewport photo pixels agree. No application workaround or image-style change was made for a screenshot artifact.

### Before and after

These curated viewport captures show the starting commit and the 16:06 UTC redesign candidate using synthetic accounts and application records. Subsequent focus, input-border and text-resize refinements retain their default-size composition. The screenshots document the candidate UI, not a claim about the live production site.

| Page | Baseline | Redesign |
|---|---|---|
| Homepage | [Before](previews/baseline-home-desktop.jpg) | [After](previews/current-home-desktop.jpg) |
| Member dashboard | [Before](previews/baseline-member-dashboard-desktop.jpg) | [After](previews/current-member-dashboard-desktop.jpg) |
| Ballot page | [Before](previews/baseline-ballot-desktop.jpg) | [After](previews/current-ballot-desktop.jpg) |
| Administrator overview | [Before](previews/baseline-admin-overview-desktop.jpg) | [After](previews/current-admin-overview-desktop.jpg) |

Mobile examples: [homepage](previews/current-home-mobile.jpg) and [ballot page](previews/current-ballot-mobile.jpg).

## Accessibility

The review combines automated axe-core 4.11.1 checks with rendered-page and keyboard inspection. It does not claim a comprehensive screen-reader or WCAG certification.

- Same-fixture baseline comparisons cover homepage, proposals, sign-in, member dashboard, ballot, administrator overview, members and settings at mobile and desktop sizes.
- The redesign removes the previous homepage ghost-action contrast failure.
- Shared input borders use the dedicated `--horizon-input-border` token: approximately 3.89:1 against white. Decorative separators remain lighter.
- Administrator attention rows and card actions stack on narrow screens instead of leaving very narrow text columns.
- Proposal rows use native list semantics. Settings previews use labelled sections, avoiding nested complementary landmarks.
- Ballot controls use equal visual treatment and labelled, keyboard-operable primitives. Review/edit/receipt focus and draft preservation are exercised by the focused harness.
- Route help is keyboard operable and has visible focus. Colour cues always accompany text and/or icons.

The initial 16-page axe comparison found no new violations and removed the earlier homepage contrast failure. After the semantic fixes, the four targeted proposal/settings checks at mobile and desktop sizes reported zero violations, overflow or page errors. The proposal search boundary measured approximately 3.60:1 on its pale lavender surface.

The final 16:22:59 UTC build passed the targeted 200% text-resize simulation for the homepage and member dashboard at 390px: document and body widths both remained 390px, with no detected control clipping. The simulation snapshots all original font sizes/line heights before doubling them. The same pages and ballot review also passed 320 CSS-pixel reflow and a 640 CSS-pixel, 2× device-scale layout representing a 1280-pixel desktop at 200% page zoom. Reduced-motion and keyboard navigation/help/review checks passed with visible 3px focus outlines and no vote submission during the checks.

These are controlled simulations, not native Firefox text-only zoom or screen-reader certification. The proposal page's strict 390px text-only simulation retained the baseline's 509px body-content width, involving a long category badge and inherited heading/count layout. The reviewed ballot controls remained readable and operable; this inherited limitation is not represented as resolved.

The final 16:37:11 UTC build passed four focused keyboard cases: public home at mobile and desktop, and the mobile administrator drawer in normal and reduced-motion modes. The skip link remains visible above the header. The drawer moves focus to its visible close control, contains Tab/Shift+Tab within available links, returns focus on Escape/close/scrim, and handles desktop/mobile resizing without trapping desktop navigation. Closed account disclosures are excluded from the Tab boundary. Reduced-motion transitions are disabled rather than creating tiny inherited-visibility transitions on otherwise unanimated elements. No source transition-end dependency was found.

## Performance observations and budgets

The change adds no runtime dependencies, font provider, analytics provider or external image host. New images use local responsive WebP variants with intrinsic dimensions, a prioritised cover image and lazy secondary images. No large decorative image is added to the formal ballot controls.

The measured 16:18 UTC candidate emitted 90 client JavaScript files totalling 1,229,277 bytes, compared with 89 files and 1,225,832 bytes in the baseline: an increase of 3,445 bytes (+0.28%). Summed per-file gzip was 391,017 → 392,459 bytes, an increase of 1,442 bytes (+0.37%). These figures cover emitted JavaScript assets, exclude inline scripts, and are not per-page download totals or a speed benchmark. The later changes are narrowly scoped navigation-focus handling, markup and CSS.

The two homepage photographs at device scale 1 selected 36,254 + 43,620 bytes on mobile and 84,504 + 98,930 bytes on desktop. At 820px the corrected home selects the 480px variants, totalling 79,874 bytes instead of the 463,720 bytes selected before matching `sizes` to the 800px layout breakpoint. The Sense Box introduction selects its 480px community image, 43,620 bytes. Both targeted cases passed without route, overflow, image, JavaScript or HTTP failures. The prior homepage photograph was 125,752 bytes at all three widths. The asset register records all six new variants and their exact dimensions/bytes.

Practical budgets for this slice are: no new runtime dependency; no backend query-path change; under 200KB combined selected homepage image bodies at the tested scale-1 widths after the tablet correction; and under 2% increase in summed compressed client JavaScript. High-density displays may correctly choose larger responsive assets.

Local synthetic rendering and payload measurements are not field Core Web Vitals. LCP, CLS and interaction responsiveness on real devices/networks and real MongoDB query latency have not been certified. Intrinsic image dimensions, unchanged server data work and the small measured script change limit the specific risks introduced by this redesign.

## Reproduce the checks

Use the pinned package manager and the repository's documented isolated database setup. Do not point these harnesses at production.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm build
pnpm docs:check-links
node scripts/member-lifecycle-browser.mjs
node scripts/security-perimeter-browser.mjs
node scripts/discussion-thread-browser.mjs
node scripts/member-profile-browser.mjs
node scripts/sense-box-amendments-browser.mjs
node scripts/ballot-review-browser.mjs
node scripts/theme-visual-browser.mjs --suite public
node scripts/theme-visual-browser.mjs --suite admin --viewports mobile,desktop
node scripts/theme-keyboard-browser.mjs
```

As with the existing browser scripts, `ENGAGE_PLAYWRIGHT_MODULE` can point to an externally installed Playwright module. The visual harness exits nonzero for a strict failure or unavailable fixture, so the known no-Mongo response and missing records remain visible to a runner. Visual and keyboard artifacts default to the ignored screenshot directory. The focused ballot harness uses a temporary directory unless `ENGAGE_SCREENSHOT_DIR` is supplied.

## Remaining boundaries

- The source branch is the delivery target; no production release, configuration change or operational job was invoked.
- This redesign does not close the governance/security programmes or merge the listed backend PRs.
- Real authentication-provider delivery, live CRM verification, private host branch watchers and deployed edge headers require their own environment evidence.
- No local test result is a claim that every administrative mutation or production voting state has been exercised.

See the implementation record for rollback boundaries and the complete source-route inventory.
