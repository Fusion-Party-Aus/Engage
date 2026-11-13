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

## REA investigation — runtime follow-up, 13 November 2026

This section extends the earlier pass; it does not retroactively turn its documentation/source findings into runtime observations. Comprehension aids were added to scope during this pass. No account was created, private record accessed, vote cast, AI provider invoked or production content changed. Only public pages, read-only navigation and a temporary browser's essential-cookie preference were exercised.

### Capability and identity boundary

REA MCP **was available in this session**: `binary_session` returned `rea-agents` 6.9.0, skill expectation 62, 255 MCP tools, no open target and no prior evidence. Tool catalogue SHA-256: `b3054fab57a222a4690d93cdba88805d7cbd2e6c0279dd596eecf213030c3797`.

The actual catalogue supports browser launch/connect scenarios; passive CDP DOM, accessibility, script and network inspection; screenshots; retained-evidence paging/export; static JavaScript/bundle analysis; and native/package analysis. Browser scenarios accept declared navigation, clicks, keyboard actions and viewport settings. Availability is not an authenticated account or permission to inspect private data. These are Rails applications with browser frontends: browser capture can observe delivered behaviour, but JavaScript analysis cannot establish their server-side Ruby permissions or persistence. Public source inspection is the appropriate corroboration. Native decompilation is unnecessary; Ghidra/IDA/Kuna were unconfigured and no native target was opened.

Runtime used an owned temporary Chrome profile (`Chromium` 156.0.8078.80), empty initial storage, light theme, reduced motion and blocked service workers. Default viewport was 1280×720; R4 used 390×844. All ten scenarios reported owned-process termination. An initial capture argument was rejected before execution; it was corrected from the installed schema. No setup or engine installation was required.

Deployed application versions/commits were **not identified**. The following independently retrieved source heads make the new source checks reproducible; none is proved to be the deployed build:

| Application | Source reference retrieved through GitHub connector |
|---|---|
| Decidim | [`bdc31912ba18620dc415db9d596ebb1be5c1c4e9`](https://github.com/decidim/decidim/commit/bdc31912ba18620dc415db9d596ebb1be5c1c4e9), `develop` |
| CONSUL Democracy | [`cff30d8c120949ac72b0b47b8c5e324dc81f128e`](https://github.com/consuldemocracy/consuldemocracy/commit/cff30d8c120949ac72b0b47b8c5e324dc81f128e), `master` |
| Loomio | [`7d15a88a8e9ab96851a03c9bda2703529e3def68`](https://github.com/loomio/loomio/commit/7d15a88a8e9ab96851a03c9bda2703529e3def68), `master` |

### Capture ledger

IDs below are the **complete parent** REA Evidence records, not the derived summary IDs. DOM/accessibility are observed browser output; claims inside a post remain the author's claims. Full evidence was checkpointed locally at `/private/tmp/engage-rea-runtime-final.json` (20 records, 2,727,723 bytes), then `reset_investigation` cleared retained state. That temporary checkpoint is not committed or a permanent repository archive; the descriptions, exact URLs and IDs below are the reviewable record. Raw public discussions and named voting records have not been republished in this research.

| Ref | Public target and declared action | Parent Evidence ID |
|---|---|---|
| R1 | [Metadecidim home](https://meta.decidim.org/), load and wait | `ev_a2f99c75ff8844cdda108aee7d8cef95b69c4ea172fba4011fcc02e692c90001` |
| R2 | [Accountability result 7257](https://meta.decidim.org/en/assemblies/coordination-committee/f/2006/results/7257), load and wait | `ev_d1cdaad3c32d2921d30b9f0a1476703f78cd79b00c5702e21086141f0cfeaa2d` |
| R3 | [Origin proposal 18735](https://meta.decidim.org/en/assemblies/coordination-committee/f/1799/proposals/18735), load and wait | `ev_b864bc9017b96d58f90138520ded44823c30b9e4ebdd666736f03bc0000b2cdf` |
| R4 | R3 at mobile viewport; accept essential cookies; press Enter on “see other versions”; capture [version 3](https://meta.decidim.org/en/assemblies/coordination-committee/f/1799/proposals/18735/versions/3) | `ev_c9abc27cf294ffa8b64158d722ee9a194911d66c4a7593ebf6ce433c3eb16367` |
| R5 | [Decide Madrid proposals](https://decide.madrid.es/proposals), load and wait; access denied | `ev_fb46e169916afeff1ae4b085d163bac834d7339497b79f21745c940eddc76054` |
| R6 | [Loomio Community](https://www.loomio.com/community), load and wait | `ev_7c38ecf946da9c7711404e10978259ffce11887787803bfa7e539aa0280438c2` |
| R7 | [Copy for AI announcement](https://www.loomio.com/d/dPLr1EmM/copy-for-ai-button), load and wait | `ev_db54018245b7dfdd753f8e1a3ceecfc268f6704d18dbdfbf0bd58749935a8ca0` |
| R8 | R6; press Enter on “View locked discussions”; wait | `ev_7d802e54adcec638e5ddbc0e15cba2f2bd25203eef70777e427aea976211616e` |
| R9 | [Historic moderation decision](https://www.loomio.com/d/DkoxeI3Q/community-moderation-policy-let-s-design-it-together), load and wait | `ev_56174c39f157b30ceacee6388733db3b90c6b840129abc2675f52f998567d062` |
| R10 | [Locked subgroup discussion](https://www.loomio.com/d/ATIvDYCG/question-how-to-upgrade-actually-or-functionally-a-subgroup-into-a-main-group), load and wait | `ev_2a429b961460d77ece3d17d773ed03488c0c9ec70bacd9df129dfbe1933133b1` |

R1 did not select network/console capture. Other scenarios selected metadata only, without response/request bodies or header values. R8 had one unfinished request and was marked incomplete for events; its final DOM/accessibility were captured. A complete capture means selected sections completed, not full journey coverage. R5's completed capture is a denial page, not a successful CONSUL journey. R7/R9 logged signed-out 401s for ancillary push-subscription/notification-count requests while public content rendered. Decidim logged service-worker blocking imposed by the test environment. No assertion of clean consoles or comprehensive API discovery follows.

### RD1 — An answer, a version change and implementation are visibly different

**Observed runtime (R2–R4; Decidim, deployed version unknown):** Proposal 18735 shows an approval answer directing readers to a new participatory process. Its history links to result 7257; that result links back to two originating proposals and a meeting, with dates, 50% progress, a work-in-progress label and a future end date. This proves public two-way provenance for this example. It does not demonstrate incorporation of a particular comment or formal constitutional adoption. The version-3 comparison records a **status** change from agenda inclusion to approval, not a wording amendment.

**Source corroboration:** The [pinned proposal model](https://github.com/decidim/decidim/blob/bdc31912ba18620dc415db9d596ebb1be5c1c4e9/decidim-proposals/app/models/decidim/proposals/proposal.rb) declares amendment fields as title/body, fingerprinting, separate answer-publication and withdrawal scopes. This explains distinct concepts without proving the observed installation uses this commit.

**Benefit/trade-off:** Related events make subsequent work inspectable, but a progress percentage is maintained reporting, not proof of delivery or mandate. **Engage relevance:** Reuse responses, `appliedRevisionId`, decision records and successor links. Test reciprocal links and distinguish a response from authorised adoption; do not add another status system or copy percentages without an operational need. **Confidence:** high for displayed relationships, low for their underlying authority/persistence.

### RH1 — Some public history is genuinely accessible; universal retention remains unproved

**Observed runtime:** R4 opened the version-3 comparison without authentication and exposed links to all three versions. The screenshot shows readable state differences and a version list at 390px; the comparison toolbar's rightmost button is clipped beyond the viewport. Enter activation on a selected link worked, but no full Tab-order, focus-visibility or screen-reader audit was performed. R8 revealed seven locked discussion links; R10 displayed the original context, replies and a lock event, without a participation button. R9 displayed a discussion begun in 2014 and its closed poll/outcome. These establish public historical access for those records, not every withdrawn/deleted/private record.

**Source/document boundary:** Loomio's [pinned discussion abilities](https://github.com/loomio/loomio/blob/7d15a88a8e9ab96851a03c9bda2703529e3def68/app/models/ability/discussion.rb) use visibility queries for reading and reject editing a locked thread. CONSUL's [pinned proposal model](https://github.com/consuldemocracy/consuldemocracy/blob/cff30d8c120949ac72b0b47b8c5e324dc81f128e/app/models/proposal.rb) retains separate retirement, explained retirement and creation-date archive concepts. R5 prevented testing their public presentation. No runtime withdrawn Decidim proposal, retired CONSUL proposal, superseded record or deleted Loomio thread was inspected.

**Benefit/trade-off:** Separate inactive discovery can preserve useful context without crowding active lists; it does not confer access to sensitive history or guarantee permanent retention. **Engage relevance:** Its archive permissions require an explicit access decision, not an automatic expansion to match public-community examples. Preserve its existing reasoned lifecycle controls. **Confidence:** high for the sampled accessible records; unresolved for the broader lifecycle matrix.

### RJ1 — A human outcome makes a tally useful but can exceed its evidence

**Observed runtime (R9; Loomio, deployed version unknown):** One thread presents context, a separately titled poll, opening/closing dates, an attributed outcome above the tally, vote-count and electorate-percentage columns, and a jump link to the poll. The outcome says the policy took effect. The poll wording primarily links to an external draft. The displayed outcome timestamp is years after the displayed poll closure, and the present page reports low participation against its displayed electorate. Neither the original electorate snapshot nor that date discrepancy was resolved; do not infer original turnout or invalidity from this display.

**Assessment:** The page usefully connects discussion, decision and subsequent action. An attributed statement that a policy is effective is not independently verified authority, and a mutable external document is not proof of exact historical ballot wording. The old thread is evidence of current historical presentation, not a test of a newly created poll.

**Engage relevance:** Preserve revision-bound snapshots and separate returning-officer results, ratification and publication. A concise reading order—exact subject, result, authority, adoption, next step—can reuse existing records. Avoid inferring governance authority from an “approved” label or an outcome author. **Benefit/trade-off:** Less interpretation effort, but narrative can mask missing authority or provenance. **Confidence:** high for presentation, unresolved for historical authority and binding wording.

### RP1 — Result hiding must be checked at each delivery boundary

**Source inspection, not a live disclosure test (Loomio pinned commit above):** [`Poll#results_available?`](https://github.com/loomio/loomio/blob/7d15a88a8e9ab96851a03c9bda2703529e3def68/app/models/poll.rb) protects open `until_closed` results; `until_vote` is explicitly a client presentation rule. [`ThreadMarkdownService`](https://github.com/loomio/loomio/blob/7d15a88a8e9ab96851a03c9bda2703529e3def68/app/services/thread_markdown_service.rb) uses that availability rule, retains attributed item boundaries/sequence numbers and distinguishes superseded votes. Its comment explicitly says exports ignore the until-vote presentation rule. [`TopicsController#markdown`](https://github.com/loomio/loomio/blob/7d15a88a8e9ab96851a03c9bda2703529e3def68/app/controllers/api/v1/topics_controller.rb) requires a current user and authorises export; [`Ability::Topic`](https://github.com/loomio/loomio/blob/7d15a88a8e9ab96851a03c9bda2703529e3def68/app/models/ability/topic.rb) ties export to topic visibility. UI export availability may impose additional restrictions; none was exercised.

This qualifies the [manual's same-visibility description](https://www.loomio.com/docs/en/user_manual/discussions/using_discussions): it must not be read as a server-enforced until-vote secrecy guarantee. [`PollMarkdownResultsService`](https://github.com/loomio/loomio/blob/7d15a88a8e9ab96851a03c9bda2703529e3def68/app/services/poll_markdown_results_service.rb) substitutes anonymous labels for anonymous result voters. Poll participation visibility separately requires quorum or half the electorate, with a minimum of three votes. This is evidence of separate mechanisms, not comprehensive anonymity assurance.

CONSUL's [pinned answer model](https://github.com/consuldemocracy/consuldemocracy/blob/cff30d8c120949ac72b0b47b8c5e324dc81f128e/app/models/poll/answer.rb) still associates answers with authors. No private ballots, anonymous poll, export endpoint or eligibility boundary was probed. Small-electorate/unanimity and repeated-report inference were assessed conceptually, not demonstrated with individuals' choices.

**Benefit/trade-off:** Presentation hiding may reduce influence without promising secrecy; server-protected delayed totals offer a different protection. Detached identities and participation thresholds still cannot prevent all inference. **Engage relevance:** Keep `canViewIdentifiableBallots`; test screens, exports, notifications and any future AI input against the same explicit policy. Do not transfer hidden-result assumptions between outputs. **Confidence:** high for inspected source paths, unknown for deployed enforcement and aggregate differencing.

### RC1 — Reading aids exist without automatic synthesis

**Observed runtime:** R3 separates an answer from author-written context/proposal sections, source links, comments, history and versions. R4 gives an exact state comparison with attribution/time and version links. R9 keeps discussion context and a poll in one thread with navigation to its decision. These are structured reading aids, not verified AI output or a neutral briefing template. No AI summary appeared in these sampled pages; this bounded observation is not a claim that none exists in any deployment.

**Documented capabilities:** Decidim supports [proposal body templates/help/preview](https://docs.decidim.org/en/develop/admin/components/proposals.html), and [unified/side-by-side version comparisons](https://docs.decidim.org/en/develop/admin/features/transparency/versions.html). Its documented [AI tools](https://docs.decidim.org/en/develop/services/aitools.html) concern spam detection, which does not establish summarisation. CONSUL's [collaborative legislation guide](https://docs.consuldemocracy.org/docs_general/participation-processes/collaborative-legislation) describes a process summary, background documents and comments anchored to selected text. That can connect debate to a clause without conflating a comment with an accepted amendment; R5 leaves its rendered journey unverified.

**Benefit/trade-off:** Context, exact comparisons and targeted navigation reduce rereading while retaining originals; author framing can still be selective and comparison tools can overwhelm mobile users. **Engage relevance:** It already supplies a proposal summary, commitments, collapsible rationale, “What you’re deciding”, ballot wording reference, amendment base/replacement comparisons and history. Validate these together before adding a briefing panel. **Confidence:** high for the sampled runtime displays and Engage source, moderate for applicability, unmeasured for comprehension improvement.

### RC2 — AI assistance is heterogeneous: export, experiment and proposed drafting help

**Observed publication (R7), corroborated source:** Loomio's team describes structured thread copying for external AI questions, then records renaming it to Copy Markdown and removing the bundled skill. The post is observable; an export/AI round trip was not executed. The pinned services in RP1 corroborate structured provenance and privacy branches, not generated summaries or neutrality review. External processing can help personal sense-making but takes material outside ongoing application controls. It is not a reason to export Engage's identifiable ballots.

**Research, not current deployment:** The authors' [2021 CONSUL/Decide Madrid study](https://arxiv.org/abs/2103.00508) investigates NLP comment summarisation alongside navigation and proposal-development aids. Its abstract reports positive evaluation; this pass did not inspect its full methods or reproduce its evaluation. It does not establish current LLM summaries, source-citation fidelity, neutrality or immutable ballot binding on Madrid.

**Planned functionality, not execution:** CONSUL's [2025–2027 Civic Assistant announcement](https://consuldemocracy.org/2025/03/announcing-ai-assistant-project/) proposes accessibility/drafting tools. The later open [assistant Part 1 issue](https://github.com/consuldemocracy/consuldemocracy/issues/6571) instead specifies advisory draft assessment: no rewriting or publication blocking, user-triggered operation, preserved draft on failure, candidate-link validation and no user identifiers in provider input. These are requested safeguards, not verified implementations. Open [Part 2](https://github.com/consuldemocracy/consuldemocracy/issues/6582) requests repeated real-provider tests, adversarial/multilingual examples and human review on model/prompt changes; hidden model instructions limit public reproducibility. Both concern authors before publication, not voters receiving balanced briefings.

**Bounded source check:** The complete CONSUL tree at the pinned commit had translation/image-suggestion LLM paths. Its [prompt file](https://github.com/consuldemocracy/consuldemocracy/blob/cff30d8c120949ac72b0b47b8c5e324dc81f128e/config/llm_prompts.yml) contained translation and image-query prompts. This focused tree/path and prompt inspection did not identify a pre-vote summariser; filenames cannot establish repository-wide absence. No deployed AI neutrality, citation or stale-summary safeguard was verified in the three platforms.

**Engage relevance:** Test source-linked comprehension first. An AI trial would need an explicit evidence and privacy specification, not a competitive parity assumption. **Benefit/trade-off:** Synthesis may help long threads but can omit minority arguments, invent agreement, privilege prolific posters or summarise stale wording. **Confidence:** high for feature-status distinctions; low for net user benefit and neutrality guarantees.

### Coverage against the investigation questions

| Question | Decidim | CONSUL Democracy | Loomio |
|---|---|---|---|
| Contribution → response → incorporation | Partial: answer/result links observed; individual amendment/comment incorporation untested | Partial: earlier docs/source; runtime denied | Partial: context/poll/outcome observed; incorporation of individual contributions untested |
| Historical wording, reasons, successors | Partial: public version/state history; withdrawal/supersession untested | Partial: pinned retirement/archive storage; public access unverified | Partial: locked detail and old decision accessible; deleted/private/successor cases untested |
| Subject, result, authority, adoption, subsequent action | Partial: linked proposals/meeting/process/result; binding authority not established | Unresolved at runtime; documentation baseline retained | Partial: poll and attributed outcome; authority and immutable external wording unresolved |
| Eligibility, participation, choices, aggregates | Source only; no live election/eligibility test | Pinned identity association; no runtime reporting test | Source distinguishes mechanisms; no private/anonymous export test or differencing test |
| Comprehension, AI and neutrality | Version aid observed; template/AI scope documented; no AI briefing verified | Anchored comments documented; NLP study and proposed AI assessment distinguished | Context/navigation observed; structured AI input supported by source; no generated summary tested |

This pass strengthens selected conclusions; it does not close authenticated journey, persistence, accessibility, deployed-version or privacy assurance gaps.
