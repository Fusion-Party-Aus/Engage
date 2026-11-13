# AI Proposal Briefings — Technical Design & Experimental Evaluation Plan

Status: **Design & experimental specification only** (PR #23). No AI provider dependency, automatic summary generation, or AI voting advice is implemented or authorised by this document.

## 1. Problem & boundaries

Long or heavily amended proposals with extensive deliberation threads can be hard for time-poor members to digest before voting. An optional, source-linked briefing could help members orient themselves, **provided it never replaces, paraphrases, or alters the formal ballot wording**.

Non-negotiable constraints:
- **Zero authority:** A briefing is an orientation aid only. It must never rewrite the motion, count discussion stances as ballots, or declare adoption.
- **Explicit separation:** The exact bound ballot snapshot (`ballotRevisionId`) must remain the primary, clearly labelled decision text.
- **Independent deployability:** Any future trial must sit behind a feature flag and an isolated service interface with no impact on core governance routes if disabled or failing.

## 2. Technical design

### 2.1 Revision-bound generation & caching
- **Cache key:** `(proposalId, revisionId, contentHash, amendmentDigest, commentDigest, promptVersion)`.
- **Invalidation:** Any change to the proposal revision (`revisionId` / `contentHash`), amendment states, or new/edited comments invalidates the cached briefing immediately (or marks it stale until regenerated).
- **24-hour TTL:** For unchanged source material (matching cache key), cache the generated briefing for **24 hours** to avoid redundant model calls and cost spikes.
- **Stale safety:** If a proposal enters `decide` or binds a new `ballotRevisionId`, any briefing generated against an older revision must be hidden or clearly marked stale—never shown as current for the active ballot.

### 2.2 Model selection & cost controls
- Use a low-cost, low-latency model tier behind a single adapter interface.
- Enforce **strict spending limits**:
  - Per-proposal generation cooldown (e.g. max 1 generation per hour per proposal unless `revisionId` changes).
  - Global daily token/cost budget cap; when reached, fail closed (hide briefing, show original proposal sources).
  - Hard input token cap (truncate/sample long threads deterministically with explicit "partial thread sampled" disclosure).

### 2.3 Source links & citation validation
- Every factual claim or argument summary in the briefing must reference a concrete Engage record ID (`revision:<id>`, `amendment:<id>`, `comment:<id>`, `ballot_result:<id>`).
- **Server-side citation validator:** Before caching or displaying a briefing, verify every cited ID exists on that proposal and is visible to the target audience. Drop or reject briefings with fabricated/dangling citations.
- **Reader-time permission filtering:** Strip or withhold any citation/claim referencing a record the current viewer cannot access.

### 2.4 Neutrality & minority-view preservation
- Structured output schema requiring:
  1. **Plain-language overview** (linked to `revision:<id>`).
  2. **Key arguments in favour** (with `comment:<id>` citations).
  3. **Key concerns & minority objections** (explicitly required even if outnumbered; never equate comment volume with consensus).
  4. **Unresolved amendments & open questions** (distinguishing `proposed` from `applied` amendments).
  5. **What is not yet decided** (e.g. ratification outstanding).
- Explicit **AI-generated label**, generation timestamp, bound `revisionId`, and a "Report an inaccuracy" link.

### 2.5 Access control & privacy
- **Never** send identifiable ballot choices (`votes`), private admin notes, member emails, or `memberId`s to any model provider.
- For `private` or `branch`-restricted proposals: do **not** send to external third-party AI providers unless an approved data-processing agreement with zero-retention guarantees is in place (or restrict the experiment initially to `national` public proposals).

### 2.6 Prompt-injection resistance
- Treat all member comments, titles, and amendment text as **untrusted data**.
- Wrap untrusted text in explicit structural delimiters and instruct the model to ignore any instructions contained within user-submitted text.
- Validate output against a strict JSON schema (no raw HTML/Markdown injection; escape all rendered text).

### 2.7 Safe failure behaviour
- Generation runs asynchronously or on-demand with a short timeout; if the provider errors, times out, or fails schema/citation validation, **render nothing** for the briefing slot and keep the normal proposal reading flow 100% functional.

## 3. Experimental evaluation plan

Before any production rollout, run a controlled offline + small-cohort evaluation:

1. **Test corpus:** Select 6–8 representative proposals: long policy proposals, proposals with conflicting/withdrawn amendments, contested threads with minority concerns, and proposals containing adversarial prompt-injection test comments.
2. **Baseline comparison:** Compare member comprehension using the **existing Engage reading flow** (brief + commitments + amendment diff + bound snapshot) vs. **existing flow + reviewed source-linked briefing**.
3. **Metrics:**
   - **Wording accuracy:** Can the member identify the exact wording being voted on?
   - **Minority-view recall:** Can the member accurately state the main objection/concern?
   - **Authority clarity:** Does the member understand whether the proposal is a draft, open ballot, or ratified policy?
   - **Citation precision:** 100% of rendered citations must resolve to real, accurate source items.
   - **Adversarial robustness:** 0% prompt-injection instruction following.
4. **Go / No-Go gate:** Proceed to a limited opt-in trial only if briefings measurably improve comprehension on complex proposals without reducing exact-wording accuracy or omitting minority views.
