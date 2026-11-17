# Collaboration gallery evidence

**Captured:** 17 November 2026 · **Build:** production (`npm run build`) · **Database:** MongoDB · **Browser:** Chromium via Playwright

These screenshots show the public gallery, the explicit publication step and the aggregate interest panel for a collaboration invitation. They are review evidence, not a promise about production content. The photograph is a generated placeholder so no real contributor image is published here.

| File | What it shows |
|---|---|
| `admin-approved-not-published.jpg` | A story approved by a reviewer, with "Publish to gallery" still offered and the note that approval is not publication. |
| `gallery-desktop.jpg` | The published story on `/collaborate/help-us-tell-fusions-story/stories/` with its answer, credit and photograph. |
| `gallery-mobile.jpg` | The same gallery at a 390 px viewport. No horizontal overflow. |
| `gallery-hidden.jpg` | The gallery after a reviewer hides the story. The story and its photograph are gone. |
| `gallery-after-withdrawal.jpg` | The gallery after the contributor's material is withdrawn. The record is retained; the public copy and photograph are gone. |
| `funnel-panel.jpg` | The editor's 30-day interest panel: arrivals, starts, sends and account steps with conversion percentages, and the note that no identities or typed content are recorded. |
| `manage-page.jpg` | A contributor's private management link, after hiding the story from the gallery. It shows the status, the correction fields and the separate withdrawal action. |
| `manage-withdrawn.jpg` | The same link after withdrawal: the material is gone, the link has stopped working, and the page is explicit that copies outside Engage cannot be recalled. |
| `manage-linked.jpg` | A signed-in contributor after optionally linking the contribution to their Engage account, with the unlink action available. |
| `profile-story.jpg` | A member profile showing a linked, published story with its excerpt and a link to the gallery anchor. Hiding the story removes this section. |
| `owners-ready.jpg` | The operational-owner setting after assigning active, verified owners who hold the review permission. The page reports the roster as assigned and ready. |
| `owners-not-ready.jpg` | The same screen after assigning a backup who lacks `collaboration.review`. The page distinguishes assigned from ready and names the reason. |

Verified in the same run: the public media route returned 200 while published and 404 once hidden or withdrawn; the image alt text read "Photograph 1 of 1 shared by Gallery Person"; the console and request log contained no errors from the gallery or interest endpoints.

Known environment note: opening the member page in local development requested `/api/auth/passkey/list-user-passkeys` and received 503 because no passkey provider is configured in that environment. That request is part of the existing sign-in page, not the gallery or its counts.
