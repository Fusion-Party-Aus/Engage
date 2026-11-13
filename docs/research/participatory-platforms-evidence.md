# Participatory governance platforms: external evidence

Research date: 13 November 2026. Companion evidence for Engage's competitive engineering research. This note records external patterns; the main report compares them with Engage before prioritising changes.

## Scope and evidence limits

The investigation uses official documentation and direct inspection of public Ruby models for Decidim, CONSUL Democracy and Loomio. **Documented behaviour** means a first-party description, **source observation** means behaviour or structure visible in the cited code, and **assessment** means our inference about its product implications. It does not claim authenticated administrator journeys were executed, votes were cast, or persistence was tested. The parent investigation records public-page inspection separately. REA MCP was not available in this session.

Public source links below select Decidim's `develop` and the other projects' `master` branches. These are moving references, accessed on the research date, not reproducible commit pins. Attempts to retrieve commit metadata through the web tool failed. Decidim documentation also uses `develop`; do not assume every documented feature exists in every deployed release. In particular, the [v0.32 release discussion](https://github.com/decidim/decidim/discussions/17262) records removal of collaborative drafts in favour of proposal co-authorship. Generic components documentation still mentions collaborative drafts, so this note does not recommend them as a current feature.

No proprietary code was copied. The short implementation descriptions below are original analysis of publicly accessible source. No competitor licences or implementations are proposed for incorporation into Engage.

## 1. Governance concepts and authority

### D1 — Decidim separates a proposed change from its review and implementation

**Documented behaviour:** A proposal can receive an official answer, while implementation is tracked through a separate Accountability result linked to originating proposals. An amendment is a proposed edit reviewed by the original proposal's author; accepting it changes the proposal and leaves a version history. This is not evidence that the author's acceptance constitutes a formal member decision. [Answers](https://docs.decidim.org/en/develop/admin/components/proposals/answers.html), [amendment workflow](https://docs.decidim.org/en/develop/admin/components/proposals/special_configurations/amendments.html), [Accountability](https://docs.decidim.org/en/develop/admin/components/accountability.html).

**Advantages:** Readers can distinguish improving a draft, accepting an idea and carrying out work. **Disadvantages:** Multiple related records can fragment the journey; author-controlled editing may not fit an organisation's amendment authority. **Engage relevance:** Preserve Engage's separate policy proposals, resolutions, amendments and formal ballots. Compare visible links between them, rather than importing Decidim's authority rules.

### C1 — CONSUL separates proposal support, voting and collaborative drafting

**Documented behaviour:** Citizen proposals collect support and can proceed to a vote after a configured threshold. Collaborative legislation has optional debate, proposal, drafting and follow-up phases; its proposal phase does not use the citizen-proposal support threshold. Its final text can be published with comments disabled. The voting guide explicitly asks administrators to say whether voting is binding. [Use guide](https://docs.consuldemocracy.org/use_guide), [collaborative legislation](https://docs.consuldemocracy.org/docs_general/participation-processes/collaborative-legislation), [voting](https://docs.consuldemocracy.org/docs_general/participation-processes/voting).

**Advantages:** Consultation does not automatically confer decision-making authority. **Disadvantages:** Similar labels across modules can obscure different rules; many optional phases demand administration. **Engage relevance:** Keep deliberative endorsement distinct from ballot approval. Make the decision's authority clear without adopting a municipality's petition thresholds or legislative machinery.

### L1 — Loomio places decisions within discussion and adds a human outcome

**Documented behaviour:** A poll can be embedded in a discussion. After closing, administrators are prompted to share an outcome describing the decision and next steps; it appears above the results and can notify participants. A review date can prompt later follow-up. [Proposals and polls](https://www.loomio.com/docs/en/user_manual/polls/intro_to_decisions).

**Source observation:** `Poll` associates multiple outcomes and a current outcome separately from its stances, and models hidden-result settings and open/closed scopes. [Poll model](https://raw.githubusercontent.com/loomio/loomio/master/app/models/poll.rb).

**Advantages:** People can read the practical consequence before interpreting a tally. **Disadvantages:** A facilitator's narrative can overstate what a vote authorised unless constrained by governance rules. **Engage relevance:** Evaluate the presentation of Engage's existing formal decisions and contribution responses. A narrative explanation must never replace revision binding or the recorded ballot result.

## 2. Responding to contributions and proving incorporation

### D2 — Decidim gives official responses their own publication controls

**Documented behaviour:** Administrators and valuators can assign statuses and explanations. Private review notes are separate from the public answer. Answers may publish immediately or be held for publication; statuses appear on cards, lists and detail views. Templates support repeated responses. [Answers](https://docs.decidim.org/en/develop/admin/components/proposals/answers.html).

**Advantages:** Consistent answers and a clear public response can close the feedback loop. **Disadvantages:** An optional explanation permits unexplained rejection; customised statuses can drift into contradictory meanings. **Engage relevance:** Engage already has structured contribution feedback and response history. Review whether the response is easy to find and whether “incorporated” links to the actual revision; do not add a duplicate response system or freely configurable governance statuses.

### D3 — Decidim makes an accepted amendment inspectable

**Documented behaviour:** The amendment workflow includes a draft and preview, notification to the proposal author, review, and acceptance or rejection. Acceptance updates the original proposal and exposes successive versions. Rejected amendments may become separate proposals if the phase permits promotion. [Amendments](https://docs.decidim.org/en/develop/admin/components/proposals/special_configurations/amendments.html).

**Advantages:** An accepted change can be checked against the text rather than a status alone. Promotion preserves a dissenter's alternative. **Disadvantages:** Proliferating proposals may split discussion; automatic text changes would be inappropriate after binding a formal ballot. **Engage relevance:** Compare the member journey to Engage's existing `appliedRevisionId`; consider discoverability of that proof, subject to existing permissions. Do not copy author acceptance as formal amendment authority.

### C2 — CONSUL makes post-selection progress public

**Documented behaviour:** Selecting a citizen proposal stops support collection and moves it into the selected view. Administrators can publish dated milestones with status, explanation and attachments, displayed as a public timeline. [Citizen proposals](https://docs.consuldemocracy.org/docs_general/participation-processes/citizen-proposals).

**Advantages:** A participant can see what happened after the idea progressed. **Disadvantages:** A timeline becomes misleading if administrators stop maintaining it. A milestone is not proof that an individual suggestion was incorporated into a text. **Engage relevance:** Reuse existing contribution responses and decisions first. A small “what happened next” record may suit actionable resolutions; a full project-management subsystem needs demonstrated demand.

### L2 — Loomio explains context edits and notifies selected readers

**Documented behaviour:** Editing discussion context permits a change summary and notification recipients. The thread records the edit. This keeps the current explanation visible while signalling that it changed. [Using threads](https://www.loomio.com/docs/en/user_manual/discussions/using_discussions).

**Advantages:** People can return without rereading everything. **Disadvantages:** A change summary alone does not establish which submission caused an edit. Selective notifications can miss affected participants. **Engage relevance:** Assess Engage's existing revision/change-summary presentation before adding notifications. Tie incorporation claims to specific contributions and revisions where available.

## 3. Historical records, withdrawal and archive

### D4 — Decidim models withdrawal separately from proposal disposition

**Source observation:** The proposal model has separate withdrawn/non-withdrawn scopes, answer publication timestamps, status scopes and amendment filtering. This establishes distinct stored concepts, not an immutable retention guarantee. [Proposal model](https://raw.githubusercontent.com/decidim/decidim/develop/decidim-proposals/app/models/decidim/proposals/proposal.rb).

**Advantages:** Withdrawal need not masquerade as rejection. **Disadvantages:** Separate concepts require clear filtering and labels. Soft deletion and version tracking do not by themselves prove permanent public accessibility. **Engage relevance:** Preserve Engage's existing archive/supersession behaviour and formal decision records. Confirm the interface explains why a proposal is inactive; do not infer that competitors guarantee preservation of every historical decision.

### C3 — CONSUL distinguishes reasoned retirement from automatic ageing

**Source observation:** `Proposal` defines retirement reasons including duplication, work started, infeasibility and completion, and validates an explanation when retired. Archive status is calculated using creation date and a configured cutoff. Archived proposals cannot receive a support through `register_vote`. Retirement and archive have separate scopes. [Proposal model](https://raw.githubusercontent.com/consuldemocracy/consuldemocracy/master/app/models/proposal.rb).

**Advantages:** Retirement can explain an outcome; ageing keeps current lists manageable. **Disadvantages:** Creation-date ageing can hide unresolved work; a “duplicated” label is weaker than an explicit successor relationship. **Engage relevance:** Engage already has stronger explicit supersession/archive concepts. Consider reason visibility and links, not automatic age-based removal or a second lifecycle vocabulary.

### L3 — Loomio offers reversible locking instead of deletion

**Documented behaviour:** Locking removes a thread from open discussions and prevents further comments/changes; closed polls are a prerequisite. Locked threads remain accessible through filters and can be unlocked. Permanent deletion is separate. [Record keeping](https://www.loomio.com/docs/en/guides/board_processes/admin), [thread actions](https://www.loomio.com/docs/en/user_manual/discussions/using_discussions).

**Advantages:** Current work stays focused while past discussions remain findable. **Disadvantages:** Reopening may confuse whether an earlier decision changed; locking is not a supersession relationship or an immutable record. **Engage relevance:** Keep history readable without presenting inactive proposals as pending work. Distinguish archival presentation from any authority to reopen a decision or ballot.

## 4. Discoverability without first-visit overload

### D5 — Decidim curates process landing pages

**Documented behaviour:** Process landing pages can show selected components such as proposals, results, documents and upcoming meetings, with configurable order. [Process landing page](https://docs.decidim.org/en/develop/admin/spaces/processes/landing_page.html).

**Advantages:** A participant can start in a bounded process rather than a global catalogue. **Disadvantages:** Curation requires maintenance; enabling every block recreates an overwhelming portal. **Engage relevance:** Use the existing proposal/discovery hierarchy and hero next action. Multiple configurable landing pages are unjustified unless Engage has many concurrent, independently run processes.

### C4 — CONSUL can hide unused modules and recommend related content

**Documented behaviour:** Operators can disable participation modules. Homepage configuration limits displayed items; personalised recommendations use tags associated with supported content. [Basic configuration](https://docs.consuldemocracy.org/tech_docs/introduction/basic_configuration), [administration](https://docs.consuldemocracy.org/docs_general/interfaces/administration).

**Advantages:** Reduced navigation and bounded lists help visitors scan. **Disadvantages:** Popularity and preference recommendations may reinforce existing interests and overlook obligations or minority concerns. **Engage relevance:** Prefer existing permission-aware next actions over a recommendation engine. The useful principle is to omit irrelevant choices, not to introduce a configurable civic portal.

### L4 — Loomio prioritises work awaiting the individual's response

**Documented behaviour:** Separate navigation exposes unread discussions and polls the person was invited to but has not voted on. Search, tags and bookmarks support later retrieval. [Finding content](https://www.loomio.com/docs/en/user_manual/overview/finding-content).

**Advantages:** A direct route to pending participation reduces scanning. **Disadvantages:** Invitation/read state can be mistaken for eligibility or obligation; many categories and bookmarks add maintenance. **Engage relevance:** Engage already has discovery and immediate next-action logic. Compare whether pending eligible ballots are readily found; do not equate a Loomio invitation with Engage's server-side voting authority.

## 5. Administrative reporting and voting privacy

### C5 — CONSUL separates aggregate results from participation statistics, but stores identity links

**Documented behaviour:** Administrators separately publish results and statistics after voting. [Voting](https://docs.consuldemocracy.org/docs_general/participation-processes/voting).

**Source observation:** `Poll::Answer` belongs to a question, selected option and author. The inspected model therefore retains an identity relationship; an aggregate public result is not evidence of detached or cryptographic anonymity. Controller/export authorisation was not fully audited. [Poll answer model](https://raw.githubusercontent.com/consuldemocracy/consuldemocracy/master/app/models/poll/answer.rb).

**Advantages:** Separate participation and outcome views can serve different administrative questions. **Disadvantages:** Stored identity linkage is sensitive; aggregate publication can still disclose choices in small groups. **Engage relevance:** Retain `canViewIdentifiableBallots` and review report/export boundaries separately from screen presentation. Do not weaken Engage's privacy boundary because a competitor has aggregate charts.

### L5 — Loomio's anonymous mode changes both storage and interaction

**Documented behaviour:** Anonymous ballots are detached from identities, hide results until closure and cannot be changed or withdrawn. New anonymous votes have no reasons or attachments. Exports are aggregate, with a specialised closed-STV recount format. Participation visibility requires a minimum turnout, never fewer than three; the documentation explicitly acknowledges unanimous and small-group inference and excludes protection against a privileged system operator. [Anonymous voting](https://www.loomio.com/docs/en/user_manual/polls/anonymous_voting/).

**Source observation:** `Poll` has separate anonymous voter and anonymous ballot associations alongside ordinary stances. That corroborates a model distinction; this inspection did not trace all persistence, export or authorisation paths. [Poll model](https://raw.githubusercontent.com/loomio/loomio/master/app/models/poll.rb).

**Advantages:** This reduces accidental application-level disclosure. **Disadvantages:** It removes vote correction/retrieval and does not solve operator trust or small-electorate inference. **Engage relevance:** A longer-term threat-model option requiring an explicit governance specification, not a UI refactor or automatic recommendation. Small-cell reporting controls can be evaluated separately without changing voting semantics.

### L6 — Loomio distinguishes analysis exports from migration backups

**Documented behaviour:** Groups can export CSV for analysis, HTML for records and JSON for migration. JSON export is group-admin controlled, excludes secret subgroups the exporter does not belong to and excludes open anonymous polls. [Group export](https://www.loomio.com/docs/en/user_manual/groups/data_export/).

**Advantages:** Purpose-specific exports avoid making a database dump the routine reporting experience. **Disadvantages:** Exported files leave the application's ongoing access controls; completeness and retention need clear explanation. **Engage relevance:** Compare Engage's existing CSV report and audit exports by audience and purpose. A portable decision record may be useful eventually; a general group migration system is unnecessary without a real migration use case.

### D6 — Do not transfer historical Decidim election claims to current releases

**Evidence boundary:** A 2020 election statistics design issue explicitly separates turnout from encrypted answer results. It is evidence of a design approach, not verification of the current Elections implementation. The v0.32 release discussion refers to a new Elections module, so historical bulletin-board descriptions cannot establish current architecture. [Statistics issue](https://github.com/decidim/decidim/issues/6014), [release discussion](https://github.com/decidim/decidim/discussions/17262).

**Advantages of the pattern:** Administrators can monitor participation without seeing interim choices. **Disadvantages:** Delayed results require explicit operational status and a trust model; historical claims can mislead procurement decisions. **Engage relevance:** Its current result/privacy rules must remain authoritative. Any proposal for hidden interim results or cryptographic elections needs fresh version-specific investigation and a governance specification.

## Questions remaining before implementation decisions

- Which existing Engage response/revision links are hard for members to discover? Source presence is not usability evidence.
- Are archive reasons and successor links obvious in an actual historical member journey?
- Do report filters or combinations expose small-group choices despite respecting individual-ballot permissions?
- Does the organisation need implementation follow-up for resolutions, or is the present decision record sufficient?
- What threat model would justify detached ballots given the loss of vote changes and retrieval?

These are validation questions, not feature commitments. No competitor demonstrates that a larger configuration surface, a different voting rule, or another technical stack would improve Engage.
