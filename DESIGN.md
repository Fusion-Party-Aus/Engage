---
name: Engage — Horizon design system
description: Fusion Party Australia's editorial visual language for participation and policy.
colors:
  horizon-purple: "#32105a"
  horizon-purple-deep: "#271047"
  horizon-accent: "#00c9d2"
  horizon-accent-hover: "#6de0e6"
  horizon-lavender: "#f2eef9"
  horizon-lavender-soft: "#f8f5fc"
  horizon-line: "#ded6e7"
  horizon-muted: "#54465f"
  horizon-white: "#ffffff"
  horizon-focus: "#006a70"
  horizon-voting-bg: "#d3f5f7"
  horizon-voting-ink: "#09474c"
  horizon-success-bg: "#dff5e8"
  horizon-success-ink: "#12472b"
  horizon-warn-bg: "#fcf0d5"
  horizon-warn-ink: "#593b06"
  horizon-danger-bg: "#fae1e1"
  horizon-danger-ink: "#631717"
typography:
  display:
    fontFamily: "Newsreader, Georgia, serif"
    fontSize: "clamp(2.4rem, 5vw, 4.1rem)"
    fontWeight: 600
    lineHeight: 1.04
    letterSpacing: "-.025em"
  section:
    fontFamily: "Newsreader, Georgia, serif"
    fontSize: "clamp(1.85rem, 3.4vw, 2.75rem)"
    fontWeight: 600
    lineHeight: 1.1
  body:
    fontFamily: "Outfit, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: "Outfit, sans-serif"
    fontSize: ".92rem"
    fontWeight: 600
rounded:
  control: ".45rem"
  container: ".75rem"
  surface: ".85rem"
  pill: "999px"
spacing:
  gap: "1rem"
  grid-gap: "1.25rem"
  section-gap: "3rem"
components:
  button-primary:
    backgroundColor: "{colors.horizon-accent}"
    textColor: "{colors.horizon-purple-deep}"
    rounded: "{rounded.pill}"
    padding: ".65rem 1.2rem"
  button-secondary:
    backgroundColor: "{colors.horizon-white}"
    textColor: "{colors.horizon-purple}"
    rounded: "{rounded.pill}"
    padding: ".65rem 1.2rem"
---

## Overview

Horizon gives Engage an editorial voice: deep violet structure, cyan actions, lavender surfaces and clear reading space. Newsreader carries headlines; Outfit carries decisions, labels and dense records. The public experience invites reading, while member and officer screens put the next action first.

**The Decision Rule.** Make the action prominent. Keep exact wording and authority close to any vote, ratification or publication action.

## Colors

Violet is the structural colour for text, navigation and authority. Cyan marks primary actions and active voting. White and lavender separate reading surfaces. Status colours identify success, warning and danger with explicit text labels. The focus colour remains visible against white and lavender.

**The Status Rule.** Never rely on colour alone to explain eligibility, stage or policy authority.

## Typography

Use Newsreader for the page and section hierarchy, and Outfit for body text, controls, metadata and task rows. Keep long policy text at a readable measure. Use tabular numerals for counts and dates.

## Layout

The public layout uses a centred content width of 74rem with generous section spacing. Reading pages narrow the text measure. Administrative pages use a violet navigation rail at desktop widths and a disclosure menu at smaller widths. Public navigation changes to a menu at 760px; the admin rail changes at 960px.

**The Reading Rule.** A page should offer one clear route into its main task before showing optional filters, provenance or procedural details.

## Elevation & Depth

Engage is mostly flat. Rules and tonal lavender surfaces provide separation; heavy shadows and floating dashboard cards are outside the established language.

## Shapes

Controls have gently rounded corners; action buttons are pill shaped. Containers and surfaces use moderate corner radii. The Fusion Horizon logo is the persistent brand mark. Ribbons are part of Horizon's identity; use them deliberately as brand composition, not as generic status decoration. The current shared CSS does not define a reusable ribbon component.

## Components

Primary cyan buttons lead to a task. Outlined buttons are secondary. Fields use visible labels, a solid border and a strong focus ring. Proposal lists and administration registers should favor scannable rows over repeated metadata cards. Navigation shows the current location with text or `aria-current`, and mobile menus expose the same destinations. Disclosure controls reveal revision, provenance and governance detail when needed.

Astro owns page structure and server rendering. Shared Astro components handle static controls and layout; shadcn-compatible React components with Radix handle tabs, dialogs and interactions that need client state. Both use the same Horizon CSS classes and tokens. Keep shadcn's interaction patterns and use Horizon for the visual language. Do not hydrate static content or create a second set of visual rules in React.

### Implementation contract

The shadcn-compatible primitives in `src/components/ui` are the only control layer. Horizon styles are applied through their variants, not by replacing them with page-specific HTML and CSS.

- Use `Button`, `Input`, `Textarea`, `NativeSelect`, `Checkbox`, `Switch`, `ToggleGroup`, `Table`, `Badge`, `Alert`, `Dialog`, `AlertDialog` and the `Card` family. Raw controls are defects.
- Plain text navigation may use `<a>`; anything presented as an action uses `Button`.
- Compose specialist interfaces from primitives. Do not recreate a primitive to achieve a local visual effect.
- Astro-only pages use the wrappers in `src/components/admin`, which mirror the same markup and variants. They must not drift from `src/components/ui`.
- Use only Horizon semantic tokens. Never add arbitrary palette utilities, hardcoded colours or undefined CSS custom properties.
- Keep a visible focus indicator on every control, especially composite radio, toggle and chip controls.
- One-off layout CSS is acceptable. One-off control CSS is not.

The normative component rules and audit command live in `AGENTS.md`, Section 4.

## Do's and Don'ts

- Do use plain language for exploration and exact governance terms at decision points.
- Do keep published policy visibly distinct from proposals and ballot results.
- Do preserve the Horizon logo, colours and type pairing on every surface.
- Do build every control from the shadcn primitives and expose Horizon through their variants.
- Don't place internal IDs, provenance classifications or procedural stages ahead of the user's task.
- Don't invent thresholds, authority rules or visual assets that are not supported by the product record.
- Don't hand-roll buttons, fields, selects, tables or modal markup when a primitive exists.
