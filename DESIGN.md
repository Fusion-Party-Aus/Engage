---
name: Engage — Horizon Community Mosaic design system
description: Fusion Party Australia's vibrant, spacious visual language for participation and policy.
colors:
  horizon-purple: "#32105a"
  horizon-purple-deep: "#271047"
  horizon-violet: "#7b2cf4"
  horizon-magenta: "#c01086"
  horizon-magenta-hover: "#a50b72"
  horizon-pink: "#f52da8"
  horizon-blue: "#278ef5"
  horizon-aqua: "#00c9d2"
  horizon-accent: "#00c9d2"
  horizon-accent-hover: "#6de0e6"
  horizon-lavender: "#f2eef9"
  horizon-lavender-soft: "#f8f5fc"
  horizon-rose-soft: "#fdf0f8"
  horizon-blue-soft: "#edf6fe"
  horizon-aqua-soft: "#e7fafa"
  horizon-line: "#ded6e7"
  horizon-input-border: "#8b7b9b"
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
    fontFamily: "Outfit Variable, Outfit, sans-serif"
    fontSize: "clamp(2.25rem, 4.5vw, 3.8rem)"
    fontWeight: 700
    lineHeight: 1.08
    letterSpacing: "-.035em"
  section:
    fontFamily: "Outfit Variable, Outfit, sans-serif"
    fontSize: "clamp(1.65rem, 3vw, 2.45rem)"
    fontWeight: 700
    lineHeight: 1.16
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
  container: "1rem"
  surface: "1.25rem"
  pill: "999px"
spacing:
  gap: "1rem"
  grid-gap: "1.5rem"
  section-gap: "3rem"
components:
  button-primary:
    backgroundColor: "{colors.horizon-magenta}"
    textColor: "{colors.horizon-white}"
    rounded: "{rounded.pill}"
    padding: ".65rem 1.2rem"
  button-secondary:
    backgroundColor: "{colors.horizon-white}"
    textColor: "{colors.horizon-purple}"
    rounded: "{rounded.pill}"
    padding: ".65rem 1.2rem"
---

## Overview

Horizon Community Mosaic is the approved white-background evolution of Engage's existing design system. It combines deep purple structure, vivid magenta actions, aqua and blue accents, generous reading space and Australian community imagery. Bold Outfit headings make the first action easy to find; quieter surfaces support longer reading. The same tokens and primitives serve public, member and officer screens.

The supplied dashboard concept establishes composition and visual character. Its invented names, counts, levels, dates and policy claims are not product data or approved features. Use the repository's official SVG logos, not the mark painted into a generated mockup.

**The Decision Rule.** Make the action prominent. Keep exact wording and authority close to any vote, ratification or publication action.

## Colors

Deep purple provides text and navigation. Accessible magenta is the primary action colour; violet, pink, cyan and blue provide supplementary brand emphasis. White is the primary background. Soft lavender, rose, blue and aqua help distinguish sections without making the page visually dense. Existing success, warning and danger tokens retain their meaning and always accompany explicit text.

The palette is defined once in `src/styles/global.css`. Do not append a second set of root overrides or hardcode replacement colours in a page. `--horizon-gradient-brand`, `--horizon-gradient-soft` and the shared shadow/radius tokens provide the approved decorative treatments.

Use white text on `--horizon-magenta` or deep purple. Use deep-purple text on aqua and pale tints. Bright pink and blue are not automatically suitable backgrounds for normal-sized white text; verify every foreground/background pair. Colour, gradients and imagery must not favour an Approve, Abstain or Reject choice.

Use `--horizon-input-border` for field boundaries: it provides more than 3:1 contrast against white and the approved pale surfaces. The lighter `--horizon-line` and `--horizon-line-strong` tokens are decorative dividers and panel borders, not substitutes for a visible field boundary.

**The Status Rule.** Never rely on colour alone to explain eligibility, stage or policy authority.

## Typography

Use the existing Outfit family for shared page and section headings, body text, controls and task rows. Newsreader remains available for existing editorial and long-form policy contexts. No new font provider or font dependency is required. Keep long policy text at a readable measure and use tabular numerals for counts and dates. A large welcome heading must not displace the next useful action on a member or officer screen.

## Layout

The public layout uses a centred maximum width of 84rem with generous section spacing. Reading pages narrow the text measure. A shared contextual-help disclosure remains available near the top of every main page. Keep it short and link to the full guide; expose exact privacy, eligibility and decision information at the action itself.

Administrative pages use a lightly tinted navigation rail, a white working surface and a clear current-location label. Public navigation changes to a menu below 1200px; the admin rail changes below 1024px. Mobile navigation must expose the same destinations and preserve visible focus. Do not force wide tables, ballot choices or forms into unreadable mobile layouts.

**The Reading Rule.** A page should offer one clear route into its main task before showing optional filters, provenance or procedural details.

## Elevation & Depth

Use rounded surfaces, fine rules and restrained shadows to separate useful groups. Gradients and flowing ribbons belong in cover compositions and section identity. Dense records and formal ballots remain calm and readable. Avoid nesting decorative cards inside cards or giving every section equal visual emphasis.

## Shapes

Controls have gently rounded corners; action buttons are pill shaped. Containers use the shared 1rem–1.25rem radii. The Fusion Horizon logo is the persistent brand mark. Ribbons are brand composition, not status decoration or an indicator of governance authority.

## Australian imagery

Use Australian people, communities, workplaces, landscapes and recognisable places. The approved cover composition has eight adults, four women and four men, with a broad range of ages and experiences. Describe imagery as illustrative when appropriate; never present generated people as named members or political endorsements. Preserve existing initials-based member avatars.

Use large imagery on the welcome experience and purposeful topic imagery in discovery. Use more restrained compositions on member workflows and especially ballots and administrator records. Do not place suggestive campaign imagery next to a particular vote choice. Image provenance, rights, alternative text and responsive sizes belong in the asset register. Decorative imagery uses empty alternative text; informative imagery needs a useful description.

## Components

Primary magenta buttons lead to a task; outlined buttons are secondary. Fields use visible labels, a solid border and a strong focus ring. Image-led cards can introduce public topics and proposals; longer lists and administration registers use scannable rows. Navigation shows the current location with text and `aria-current`, with section colour as an additional cue. Disclosure controls reveal revision, provenance and governance detail when needed.

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
- Do preserve the official Horizon logo and use this approved palette and existing font families consistently.
- Do keep exact ballot wording, previously recorded choices and truthful pending/failed states intact while changing presentation.
- Do preserve the independent, database-free error layout so the failure screen can render when the application cannot.
- Do build every control from the shadcn primitives and expose Horizon through their variants.
- Don't place internal IDs, provenance classifications or procedural stages ahead of the user's task.
- Don't invent thresholds, authority rules or visual assets that are not supported by the product record.
- Don't hand-roll buttons, fields, selects, tables or modal markup when a primitive exists.
