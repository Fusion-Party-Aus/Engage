# Notifications, PWA & Web Push Architecture

## Overview

Engage delivers member notifications across three coordinated channels without duplicating alerts or inferring consent across channels:

1. **Email (`src/lib/email-templates.ts`, `src/lib/engagement-email.ts`, `src/lib/member-reengagement.ts`)**
   - Horizon-branded, responsive (`max-width: 600px`), dark-mode-safe (`color-scheme`) HTML and plain-text templates for six lifecycle journeys: closing-soon digest, new ballot announcement, mid-period reminder, approved re-engagement, contribution response, and membership/account updates.
   - All dynamic member names, proposal titles, and notes are HTML-escaped.
   - Re-engagement campaigns require explicit administrative approval (`approveReengagementCampaign`) before `runApprovedReengagementBatch` can send, with bounded batch sizes (max 25), outbox deduplication, and pre-send suppression/opt-out rechecks.

2. **In-App Notification Inbox (`src/lib/notifications.ts`, `src/pages/api/notifications/inbox.ts`)**
   - Persistent `member_notifications` records with per-member `dedupeKey` uniqueness (`notification_deliveries`) and read/unread tracking (`markNotificationRead`, `markAllNotificationsRead`).

3. **Self-Hosted Web Push (`src/lib/web-push.ts`, `src/pages/api/notifications/push-subscription.ts`, `public/sw.js`)**
   - Standard VAPID Web Push (`web-push`) with multi-device subscriptions (`push_subscriptions`), explicit browser permission gating, and automatic `404`/`410` endpoint cleanup.
   - **Consent isolation**: Push defaults to `false` for all topics and is never inferred from email preferences.
   - **Lock-screen confidentiality**: When `isConfidential: true`, push payloads omit private branch titles and show a generic prompt to open Engage.

4. **Installable PWA (`public/manifest.webmanifest`, `public/sw.js`, `src/layouts/SiteLayout.astro`)**
   - App icons (`icon-192.png`, `icon-512.png`, `apple-touch-icon.png`) generated from `public/fusion_horizon_logo.svg`.
   - Service worker caches static assets (`/icons/`, `/_astro/`, `/manifest.webmanifest`) and explicitly bypasses `/api/*` and document navigations so authenticated governance data is never cached offline.

## Unified Preferences UI

- `src/components/member/NotificationCenter.tsx` (mounted via `src/components/member/EmailPreferences.astro` on `/member/?view=notifications`) uses Horizon/shadcn primitives (`Card`, `Switch`, `Button`, `Badge`, `Alert`, `Separator`).
- Copy and layout follow `impeccable` and `humanizer` guidelines: concise Australian English, clear hierarchy, no persuasive urgency, and inline error/status feedback.

## Production Environment Requirements

Set the following environment variables in production before enabling live email or push delivery:

- `RESEND_API_KEY`, `AUTH_EMAIL_FROM`, `RESEND_WEBHOOK_SECRET`, `ENGAGE_EMAIL_SECRET`, `PUBLIC_ORIGIN`
- `ENGAGE_DIGEST_ENABLED=true` (and authenticated cron calls to `/api/email/digest`)
- `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (e.g. `mailto:notifications@fusionparty.org.au`)

## Verification Status

- Automated unit and integration tests cover all 6 email templates, VAPID subscription lifecycle & `404`/`410` cleanup, independent email vs push consent, lock-screen confidentiality, deduplication, approval-gated re-engagement batches (with mock `fetch`), and PWA/SW static caching rules.
- Live Resend sending and inbox receipt at `ethan.c@fusionparty.org.au` remain **unverified** in this local environment because `RESEND_API_KEY`, `AUTH_EMAIL_FROM`, and `PUBLIC_ORIGIN` are not configured in `.env`.
