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

Verified in the same run: the public media route returned 200 while published and 404 once hidden or withdrawn; the image alt text read "Photograph 1 of 1 shared by Gallery Person"; the console and request log contained no errors from the gallery or interest endpoints.

Known environment note: opening the member page in local development requested `/api/auth/passkey/list-user-passkeys` and received 503 because no passkey provider is configured in that environment. That request is part of the existing sign-in page, not the gallery or its counts.
