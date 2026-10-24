# Editorial policy for website copy

This policy guides public and member-facing copy on the Fusion Horizon Policy Platform. It applies to page introductions, policy catalogue labels, consultations, ballots, forms, system messages, administration, metadata, and accessibility text.

## Editorial standard

Write so a member can quickly understand what they are looking at, its current status, and what they can do next. Give each element only the attention its information deserves.

Choose content deliberately. Do not shorten every section to the same degree, preserve a section out of habit, or add copy to fill a familiar page template. Keep useful policy detail. Remove repetition and generic promotion. A page may be dense where comparison, provenance, evidence, or rules matter, and brief where the interface already explains the task.

## Accuracy and decision language

- Use approved policy text, recorded decisions, and configured platform state as sources of truth. Do not invent claims, outcomes, endorsements, deadlines, eligibility rules, or participation figures.
- State consequential status plainly and near the relevant action: draft, open, closed, or result published. Do not imply that a preview, consultation, proposal, or simulation is binding.
- Keep these terms distinct:
  - **Policy**: wording already adopted or published as policy.
  - **Proposal**: wording under development or consideration.
  - **Consultation**: a process for comments, amendments, or alternative directions; it is not a vote.
  - **Ballot**: a formal decision on one question or policy version under stated rules.
  - **Preview/demo**: synthetic activity that has no effect on Fusion decisions.
- Name each decision separately when members are being asked to decide separate questions. Keep consultation feedback separate from formal approval voting.
- Describe an outcome as determined only when the ballot has closed and the applicable counting and verification process is complete. Explain exceptional processes only from authorised governance rules.
- Describe identity, eligibility, privacy, and confidentiality only as the system actually implements them. Never present synthetic identities as membership verification.

## Voice and structure

- Use direct, concrete language and Australian English. Prefer familiar verbs such as *read*, *compare*, *comment*, *propose*, and *vote*.
- Use product terms consistently. Explain specialist terms such as *provenance* where members need them to act or interpret a policy.
- Give a page one clear primary job. Lead with the information that supports it; put context and detail where they help someone make a decision.
- Let section length and visual weight follow importance. Use lists, tables, headings, or disclosure controls when they make real information easier to scan; do not use cards, metrics, slogans, or calls to action as filler.
- Prefer specific labels that name the action and object. Keep one name for the same action throughout the platform.
- Do not restate a heading in the next paragraph, repeat preview warnings without a reason, or explain controls whose purpose is already clear.

## Content and interface boundaries

- Keep reusable components focused on layout and behaviour. Pass page-specific editorial content into them rather than embedding page claims or campaign copy in presentation components.
- Store structured route content in the relevant data module, such as `src/data/site-copy.json`. Keep policy wording and provenance in the policy catalogue/source records, not duplicated in presentation templates.
- Keep interface-state messages close to the operation that produces them. Loading, empty, error, and success messages must reflect actual system state and give a useful next step when one exists.
- Forms use persistent labels. Mark optional fields, put important requirements before submission, and explain errors in plain language without exposing internal codes.
- Use descriptive alternative text when an image conveys information. Use empty alternative text for decoration. Do not put essential status or meaning in an image, colour, or icon alone.

## Review before publishing

For every page or substantial copy change, check:

1. Is the page's purpose clear in its first view?
2. Are policy, proposal, consultation, ballot, and preview states unmistakable?
3. Does each section add useful information or support an action?
4. Are factual statements traceable to an approved source or current system state?
5. Are actions, outcomes, errors, and next steps clear at mobile widths and with a keyboard or screen reader?
6. Could any phrase make synthetic activity, eligibility, confidentiality, or a draft decision seem more authoritative than it is?

Remove or redesign content that fails these checks. Do not cut useful detail merely to achieve a shorter page.
