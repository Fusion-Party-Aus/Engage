export type LegalTone = "info" | "warning";

export type LegalBlock =
  | { type: "paragraph"; text: string }
  | { type: "subheading"; text: string }
  | { type: "list"; items: string[]; ordered?: boolean }
  | {
      type: "definitions";
      items: Array<{ term: string; description: string }>;
    }
  | { type: "callout"; title: string; text: string; tone?: LegalTone };

export interface LegalSection {
  id: string;
  number: string;
  title: string;
  blocks: LegalBlock[];
}

export interface LegalApproval {
  status: string;
  legalReview: string;
  authorisedBy: string;
  notes: string[];
}

export interface LegalDocument {
  slug: "privacy" | "terms";
  title: string;
  shortTitle: string;
  description: string;
  version: string;
  status: string;
  publicationStatus: "owner-authorised" | "published";
  effectiveDate: string;
  operator: string;
  abn: string;
  registeredPartyName: string;
  registeredPartyAbbreviation: string;
  address: string;
  contact: string;
  lastUpdated: string;
  sections: LegalSection[];
  approval: LegalApproval;
}

const ownerAuthorisedApproval: LegalApproval = {
  status:
    "Owner authorisation recorded for this version. Formal publication approval, if separately required, and the effective date remain outstanding.",
  legalReview:
    "Not completed. Qualified legal review remains outstanding. Nothing in this document is a representation of legal clearance.",
  authorisedBy:
    "Owner authorisation confirmed. The formal publication approving office-holder and approval date are not recorded.",
  notes: [
    "Confirm the formal publication approval office-holder and date, if Fusion's rules require a separate publication approval.",
    "Confirm and set the effective date on publication.",
    "Confirm whether the Privacy Act 1988 (Cth) applies to each Engage activity, or whether Fusion will opt in or adopt APP-aligned standards voluntarily.",
    "Confirm whether an express consent step is required at first sign-in for sensitive information, including political opinions and party membership.",
    "Confirm the complaints handling procedure and expected response times.",
    "Confirm retention periods for server logs, backups, expired sessions and closed accounts.",
    "Confirm backup frequency, encryption at rest and off-host storage arrangements.",
    "Confirm who holds production database and host access.",
    "Confirm the hosting location and any CDN, tunnel, reverse-proxy or infrastructure provider that processes request data.",
    "Confirm the data processing terms and overseas processing locations for Google and Resend.",
    "Confirm the relationship between this document and Fusion's existing website privacy policy.",
    "Confirm the account correction and deletion procedure, including what can be removed from governance records.",
    "Confirm the data breach response owner and procedure.",
    "Confirm the minimum age and membership eligibility rules for Engage accounts.",
    "Confirm the governing-law clause with legal review. Victoria is stated from Constitution v1.8 and the Mansfield VIC correspondence address.",
    "Establish and publish the grounds, safeguards, member notice and escalation requirements for administrative ballot intervention.",
    "Confirm whether small ballots should suppress or further aggregate public tallies to avoid effectively revealing individual choices.",
    "After publication approval, activate the legal acceptance gate by setting both documents to published status and enabling LEGAL_ACCEPTANCE_ENABLED.",
  ],
};

export const privacyPolicy: LegalDocument = {
  slug: "privacy",
  title: "Engage Privacy Policy",
  shortTitle: "Privacy Policy",
  description:
    "How Fusion Party Australia collects, uses, shares and retains personal information in Engage.",
  version: "1.0 (owner-authorised; publication pending)",
  status: "Owner authorised · publication pending",
  publicationStatus: "owner-authorised",
  effectiveDate: "To be set by the release owner on publication",
  operator: "FUSION POLITICAL PARTY INCORPORATED",
  abn: "20 845 177 664",
  registeredPartyName: "votefusion.org for big ideas",
  registeredPartyAbbreviation: "votefusion.org",
  address: "254 McLeod Lane, Mansfield VIC 3722",
  contact: "contact@fusionparty.org.au",
  lastUpdated: "8 November 2026",
  sections: [
    {
      id: "about",
      number: "1",
      title: "About this policy",
      blocks: [
        {
          type: "paragraph",
          text: `Engage is Fusion Party Australia's member participation and governance platform. Anyone can read public proposals and published policy. Signed-in members can discuss proposals, suggest wording changes, vote in ballots they are eligible for, and take part in branch activity.`,
        },
        {
          type: "paragraph",
          text: `This policy explains what personal information Engage handles, why we handle it, who can see it, how long we keep it and how you can ask about it. It applies to Engage at engage.fusionparty.org.au and to member accounts on Engage.`,
        },
        {
          type: "paragraph",
          text: `Engage is operated by FUSION POLITICAL PARTY INCORPORATED (ABN 20 845 177 664). Fusion Party Australia is the public name used in Engage. The party is currently registered with the [Australian Electoral Commission](https://www.aec.gov.au/parties_and_representatives/party_registration/Registered_parties/) as "votefusion.org for big ideas" (registered abbreviation "votefusion.org"). We have written this policy with reference to the Australian Privacy Principles (APPs) as a matter of good practice. Registered political parties are generally exempt from the Privacy Act 1988 (Cth) in relation to political acts and practices, and the Office of the Australian Information Commissioner (OAIC) describes registered political parties as exempt. Whether the Act applies to a particular activity is a legal question for Fusion to confirm. This policy is not a statement that the Act applies, and it is not legal advice.`,
        },
        {
          type: "paragraph",
          text: `This policy does not cover Fusion's main website, membership database, mailing lists or third-party websites. Fusion's [existing website privacy policy](https://www.fusionparty.org.au/privacy_policy) describes the main website and older third-party services; it does not describe Engage. Those services may have separate privacy notices. If there is a conflict, the notice for the relevant service applies to that service.`,
        },
        {
          type: "callout",
          title: "Engage is not a confidential channel",
          text: `Public proposals, comments, display names and aggregate vote counts can be read by anyone who can see that proposal. Do not use Engage for private, confidential or sensitive communications that you do not want published.`,
          tone: "warning",
        },
      ],
    },
    {
      id: "information-we-collect",
      number: "2",
      title: "Information we collect",
      blocks: [
        { type: "subheading", text: "Account and membership information" },
        {
          type: "paragraph",
          text: `When you sign in, we create or update an Engage account. We collect:`,
        },
        {
          type: "list",
          items: [
            `your full name, as entered at sign-in or in your account;`,
            `your email address and whether it has been verified;`,
            `a member identifier and account timestamps;`,
            `your platform role (member, moderator or administrator), membership status (pending, verified or suspended) and whether your account is disabled;`,
            `branch memberships, branch administrator delegations, and who assigned or revoked them;`,
            `if you use Google sign-in, the account identifier and profile information Google returns, such as name, email address, email-verification status and profile image.`,
          ],
        },
        {
          type: "paragraph",
          text: `Engage does not use a password for the sign-in methods configured in this release. If Fusion enables another sign-in method, this policy will be updated.`,
        },
        { type: "subheading", text: "Authentication and security information" },
        {
          type: "paragraph",
          text: `When you request an email sign-in link, we process your email address and a single-use token. The token is stored in hashed form, expires after 10 minutes and can be used once. When you are signed in, Better Auth, the authentication library used by Engage, creates a session record. Session records may include a session identifier, the associated account, expiry time, IP address and browser user-agent. We also keep rate-limiting and security records to prevent abuse.`,
        },
        {
          type: "paragraph",
          text: `If you use Google sign-in, Google may return authentication tokens and account-linkage data that Better Auth stores to maintain the connection. Google handles your Google account under its own privacy policy.`,
        },
        { type: "subheading", text: "Membership verification and branches" },
        {
          type: "paragraph",
          text: `Fusion verifies membership manually. An administrator compares the name and email on your account with Fusion's membership records and sets your membership status. Engage does not currently connect to an external membership database or verify membership automatically. Administrators also assign branch memberships and may delegate branch administrator access. These changes are recorded with the actor and time.`,
        },
        { type: "subheading", text: "Participation records" },
        {
          type: "paragraph",
          text: `When you participate, we store the content you submit and information needed to attribute and audit it:`,
        },
        {
          type: "list",
          items: [
            `proposals: title, summary, outcomes, details, supporting links or attachments, topic, stage, originating branch, governance authority, jurisdiction, publication scope, your display name and member identifier, timestamps, and each saved wording revision;`,
            `contributions: your display name, stance, text, timestamp and endorsements. An endorsement is stored as a member identifier; the public page shows only the number of endorsements;`,
            `formal amendments: the proposed wording, the revision it is based on, your member identifier, timestamps, status, revision history, any conflict flag and any administrative reason;`,
            `votes: the ballot and proposal, the exact wording revision, your choice, an optional reason of up to 500 characters, your display name, your member identifier and the time you voted or last changed your vote;`,
            `ballot administration: recorded outcomes, decision event references, binding events, ratification records and publication events.`,
          ],
        },
        {
          type: "paragraph",
          text: `Your display name is recorded with each contribution, proposal and vote at the time you submit it. Changing your account name later does not rewrite those historical records.`,
        },
        { type: "subheading", text: "Administrative and audit records" },
        {
          type: "paragraph",
          text: `Engage records some administrative actions, including role and membership changes, branch membership changes, branch creation and edits, ballot wording binding, ballot results, ratification and publication. These records include the actor's member identifier, the action, the time and, for some branch changes, before-and-after snapshots. Not every administrative action produces a complete immutable audit event. We also keep a record when a member accepts the current Terms of Use and acknowledges the current Privacy Policy, including the versions, content hashes and time of acceptance.`,
        },
        { type: "subheading", text: "Technical and operational information" },
        {
          type: "paragraph",
          text: `Our servers and hosting infrastructure may record technical information such as IP address, browser user-agent, requested URL, timestamp, response status and error details. These logs support security, troubleshooting and service operation. The application database is self-hosted on infrastructure operated for Fusion and is not exposed directly to the public.`,
        },
        { type: "subheading", text: "What we do not collect in this release" },
        {
          type: "paragraph",
          text: `Engage does not include third-party analytics, advertising trackers or advertising cookies. It does not process payment card details. It does not ask for your date of birth, home address, phone number, health information or biometric data. It does not build advertising or marketing profiles. If Fusion introduces analytics, advertising or other new processing, this policy will be updated before that processing begins.`,
        },
      ],
    },
    {
      id: "political-sensitive-information",
      number: "3",
      title: "Political and sensitive information",
      blocks: [
        {
          type: "paragraph",
          text: `Much of the information in Engage is sensitive information under Australian privacy law. This includes information about your membership of a political party, your political opinions, how you vote and what you say about policy. It can also reveal your branch or electorate.`,
        },
        {
          type: "paragraph",
          text: `We collect this information because you choose to sign in and participate, and because it is necessary to run a member participation and governance platform. We do not use it for advertising or sell it.`,
        },
        {
          type: "paragraph",
          text: `Some of this information is public. Your display name appears with your contributions and on proposals you author. Your comments, stance and the proposals you author can be read by anyone who can see that proposal. Aggregate vote counts are public. In a small ballot, the aggregate result can effectively reveal how a small number of voters voted, even though the application does not display individual names.`,
        },
        {
          type: "paragraph",
          text: `Your individual vote and optional reason are not displayed publicly. They are available to you in My Engage and to national administrators through Engage's administrative functions. National administrators can identify how you voted, including your member identifier, display name, choice and reason. A branch administrator who is not also a national administrator does not receive identifiable ballot records through Engage, and moderators do not receive them. We do not describe voting as anonymous or secret.`,
        },
        {
          type: "callout",
          title: "Identifiable ballot records",
          text: `National administrators can access identifiable ballot records, including member identifiers, display names, choices and optional reasons. Do not vote or write a reason on the assumption that your choice is anonymous.`,
          tone: "warning",
        },
        {
          type: "paragraph",
          text: `By choosing to sign in and participate, you are asking Fusion to handle this information for the purposes described in this policy. You can choose not to provide it, but you may then be unable to participate. If public attribution creates a safety or privacy risk for you, contact us at [contact@fusionparty.org.au](mailto:contact@fusionparty.org.au) before you post to discuss whether any alternative attribution arrangement is available while preserving membership verification.`,
        },
      ],
    },
    {
      id: "why-we-use-information",
      number: "4",
      title: "Why we use information",
      blocks: [
        { type: "paragraph", text: `We use personal information to:` },
        {
          type: "list",
          items: [
            `authenticate you and keep your account secure;`,
            `verify your membership and branch eligibility;`,
            `let you browse, discuss, propose, amend and vote in the ways your account permits;`,
            `administer ballots, record outcomes and maintain the integrity of the exact wording voted on;`,
            `maintain governance, ratification, publication and audit records;`,
            `operate, troubleshoot, secure and improve the reliability of Engage;`,
            `respond to your requests, complaints and privacy enquiries;`,
            `comply with legal obligations and lawful requests.`,
          ],
        },
        {
          type: "paragraph",
          text: `We do not sell, rent or trade personal information. We do not disclose it for advertising. We may use aggregated or de-identified participation counts for governance reporting and service operation, and we take care not to re-identify individuals.`,
        },
      ],
    },
    {
      id: "who-can-see-information",
      number: "5",
      title: "Who can see information",
      blocks: [
        { type: "subheading", text: "Anyone" },
        {
          type: "paragraph",
          text: `Anyone can read public proposals, published policy, recognised branch names, author display names, contributions and aggregate vote counts. Public means anyone with access to Engage, whether or not they have an account.`,
        },
        { type: "subheading", text: "Signed-in members" },
        {
          type: "paragraph",
          text: `Signed-in members can see their own account details, their own votes and reasons, their own contributions and proposals, and branch-scoped proposals for branches they belong to. Members do not receive a public member directory or other members' email addresses.`,
        },
        { type: "subheading", text: "Branch administrators" },
        {
          type: "paragraph",
          text: `Branch administrators can see and manage membership and proposal workflow for the branches explicitly assigned to them. A branch administrator who is not also a national administrator does not receive identifiable ballot records through Engage.`,
        },
        { type: "subheading", text: "Moderators and national administrators" },
        {
          type: "paragraph",
          text: `Moderators can review proposals and contributions and take moderation actions. National administrators can also manage member accounts, roles, branches, ballots, ratification and publication. National administrators can access identifiable ballot records. Moderators do not receive identifiable ballot records.`,
        },
        { type: "subheading", text: "What is not public" },
        {
          type: "paragraph",
          text: `The following is not displayed publicly: email addresses; member identifiers; session, authentication and security records; individual votes and reasons; private or branch-restricted proposals; membership status; branch membership lists; and administrative or audit records.`,
        },
      ],
    },
    {
      id: "disclosure",
      number: "6",
      title: "Disclosure and service providers",
      blocks: [
        {
          type: "paragraph",
          text: `Engage uses a small number of external services. The implementation evidence identifies the following:`,
        },
        {
          type: "definitions",
          items: [
            {
              term: "Google",
              description: `If Google sign-in is enabled and you choose it, Google processes your sign-in request under its [privacy policy](https://policies.google.com/privacy). Fusion receives the account identifier and profile information Google returns, such as your name, email address, email-verification status and profile image.`,
            },
            {
              term: "Resend",
              description: `Resend delivers Engage sign-in emails and membership verification notices. Resend receives the recipient email address, the message content (which may include your name and a single-use sign-in link) and delivery metadata. See the [Resend privacy policy](https://resend.com/legal/privacy-policy).`,
            },
            {
              term: "Self-hosted infrastructure",
              description: `The Engage application and database run on infrastructure operated for Fusion. Deployment documentation does not identify a separate database-as-a-service provider. Network, hosting and reverse-proxy providers used to deliver the service may process request metadata as part of operating the service.`,
            },
          ],
        },
        {
          type: "paragraph",
          text: `Access within Engage is limited to the roles described in this policy and to authorised administrators who need it. A branch administrator who is not also a national administrator sees membership and branch information for their assigned branches, not identifiable ballots. Personnel who administer the database or hosting infrastructure may also have technical access to stored records. That access is restricted to authorised operators and should be subject to confidentiality and least-privilege controls.`,
        },
        {
          type: "paragraph",
          text: `We may disclose information if required or authorised by law, a court or tribunal order, or to protect the safety and security of people or the service. We may also disclose it to professional advisers under confidentiality if needed for a legal or governance matter.`,
        },
        {
          type: "paragraph",
          text: `We do not sell personal information.`,
        },
      ],
    },
    {
      id: "overseas",
      number: "7",
      title: "Overseas processing",
      blocks: [
        {
          type: "paragraph",
          text: `Google and Resend are external service providers and may process information outside Australia. Fusion is confirming their processing locations and contractual terms. The Engage database is self-hosted on infrastructure operated for Fusion; its storage location and backup arrangements are being confirmed.`,
        },
        {
          type: "paragraph",
          text: `If the APPs apply, APP 8 requires Fusion to take reasonable steps before disclosing personal information overseas. Fusion should confirm whether an exception applies.`,
        },
      ],
    },
    {
      id: "security",
      number: "8",
      title: "Security",
      blocks: [
        {
          type: "paragraph",
          text: `Engage uses technical and organisational controls to protect personal information, including:`,
        },
        {
          type: "list",
          items: [
            `HTTPS for production access through Fusion's reverse proxy;`,
            `a session cookie that is intended to be HttpOnly and Secure in production;`,
            `hashed, single-use sign-in tokens with a 10-minute expiry;`,
            `rate limiting and session expiry;`,
            `role-based access for members, moderators, branch administrators and national administrators;`,
            `redaction of other members' ballot records for everyone except national administrators;`,
            `a database that is not directly exposed to the public and is accessed with a scoped database user;`,
            `audit records for sensitive governance actions;`,
            `backups of the Engage database, stored outside the application host with access restricted to authorised operators;`,
          ],
        },
        {
          type: "paragraph",
          text: `No method of transmission or storage is completely secure. If you suspect unauthorised access to your account, contact us immediately.`,
        },
        {
          type: "paragraph",
          text: `If a data breach occurs, Fusion will contain and assess it, and notify affected individuals and the OAIC where required or appropriate.`,
        },
      ],
    },
    {
      id: "retention",
      number: "9",
      title: "Retention",
      blocks: [
        {
          type: "paragraph",
          text: `We keep personal information only as long as needed for the purposes in this policy, including to maintain governance records. Engage does not currently apply automatic deletion schedules to most records.`,
        },
        {
          type: "definitions",
          items: [
            {
              term: "Account and profile",
              description: `Kept while your account is active and afterwards as needed for membership, governance, security or legal purposes. There is no automatic deletion schedule.`,
            },
            {
              term: "Sign-in and session records",
              description: `Sign-in tokens expire after 10 minutes. Session records are kept until they expire or are revoked. Expired records may remain until routine cleanup.`,
            },
            {
              term: "Contributions",
              description: `Kept until you or an authorised moderator deletes them, or until the proposal is deleted. Backups may retain copies for a limited period.`,
            },
            {
              term: "Proposals and revisions",
              description: `Saved wording revisions, hashes and revision history are kept as governance records. When an administrator deletes a proposal, the live proposal and its comments are removed; revision history and vote records may remain.`,
            },
            {
              term: "Votes and ballot records",
              description: `Kept as decision records so that ballots can be audited. They are not automatically removed when a proposal is deleted.`,
            },
            {
              term: "Ratification and publication",
              description: `Ratification, publication, withdrawal and supersession records are kept as part of the public governance record.`,
            },
            {
              term: "Audit and administrative events",
              description: `Kept to explain who changed what and when. Some are immutable.`,
            },
            {
              term: "Legal acceptance records",
              description: `Kept to evidence which Terms and Privacy Policy versions a member accepted and when. Retained as part of the governance and compliance record.`,
            },
            {
              term: "Server logs and backups",
              description: `Server log and backup retention periods are under review and will be published when finalised.`,
            },
          ],
        },
        {
          type: "paragraph",
          text: `Account deletion is not currently self-service. Disabling an account prevents sign-in but does not erase records. Requests for correction or deletion can be sent to the contact address below; some records may need to be retained for governance integrity.`,
        },
      ],
    },
    {
      id: "access-correction-deletion",
      number: "10",
      title: "Access, correction and deletion",
      blocks: [
        {
          type: "paragraph",
          text: `You can see your account details, votes, contributions and proposals in My Engage. You can change your display name there.`,
        },
        {
          type: "paragraph",
          text: `The current interface does not let you change your email address or delete your account yourself. To request access, correction or deletion, contact [contact@fusionparty.org.au](mailto:contact@fusionparty.org.au). We may need to verify your identity.`,
        },
        {
          type: "paragraph",
          text: `We will respond within a reasonable period. We will explain if we cannot meet a request, including where a governance record must be retained.`,
        },
        {
          type: "paragraph",
          text: `You cannot rewrite a vote after a ballot closes. You can change your vote while the ballot is open. Correction of a factual record may be recorded as a correction or note rather than by erasing the original.`,
        },
        {
          type: "paragraph",
          text: `If you believe we have handled your information incorrectly, contact us first. If Fusion is covered by the Privacy Act for the relevant handling, you may also complain to the OAIC. Because registered political parties are generally exempt for political acts and practices, the OAIC may not be able to investigate every complaint. Fusion will still consider your complaint.`,
        },
        {
          type: "definitions",
          items: [
            {
              term: "OAIC",
              description: `Phone 1300 363 992 or visit the [OAIC website](https://www.oaic.gov.au/).`,
            },
          ],
        },
      ],
    },
    {
      id: "cookies",
      number: "11",
      title: "Cookies and tracking",
      blocks: [
        {
          type: "paragraph",
          text: `Engage uses a strictly necessary session cookie to keep you signed in. In production it is intended to be HttpOnly and Secure. Development sign-in cookies are only available in development, test or preview modes and are not used in production.`,
        },
        {
          type: "paragraph",
          text: `This release does not use third-party analytics, advertising pixels or tracking cookies. It does not create advertising or marketing profiles.`,
        },
        {
          type: "paragraph",
          text: `Server logs may record technical request data as described in section 2. If analytics is introduced, this policy will be updated and any consent requirement will be implemented before use.`,
        },
      ],
    },
    {
      id: "changes",
      number: "12",
      title: "Changes to this policy",
      blocks: [
        {
          type: "paragraph",
          text: `We may update this policy. The current version and status appear at the top of this page. If a change materially affects how we handle personal information, we will take reasonable steps to notify members before it applies, and seek consent where required.`,
        },
        {
          type: "paragraph",
          text: `Owner authorisation has been recorded for this version. The effective date will be set on publication after any separate formal approval required by Fusion's rules.`,
        },
      ],
    },
    {
      id: "contact",
      number: "13",
      title: "Contact",
      blocks: [
        {
          type: "paragraph",
          text: `For privacy questions, access, correction or deletion requests, or complaints, contact [contact@fusionparty.org.au](mailto:contact@fusionparty.org.au). Legal correspondence: 254 McLeod Lane, Mansfield VIC 3722.`,
        },
        {
          type: "paragraph",
          text: `If you are not satisfied with our response, you may contact the OAIC at 1300 363 992 or through the [OAIC website](https://www.oaic.gov.au/).`,
        },
        {
          type: "paragraph",
          text: `We may update these contact details. The current details will be published here.`,
        },
      ],
    },
    {
      id: "legal-framework",
      number: "14",
      title: "Legal and organisational framework",
      blocks: [
        {
          type: "paragraph",
          text: `Engage is operated by FUSION POLITICAL PARTY INCORPORATED (ABN 20 845 177 664). Fusion Party Australia is the public name used in Engage. The party is currently registered with the [Australian Electoral Commission](https://www.aec.gov.au/parties_and_representatives/party_registration/Registered_parties/) as "votefusion.org for big ideas" (registered abbreviation "votefusion.org"). The Privacy Act 1988 (Cth) and the APPs apply to many organisations. Registered political parties are generally exempt in relation to political acts and practices. The OAIC's guidance states that a registered political party is exempt. The statutory tort for serious invasions of privacy, which commenced on 10 June 2025, can apply more broadly than the APPs.`,
        },
        {
          type: "paragraph",
          text: `This policy is written with reference to the APPs as a matter of good practice. It does not replace Fusion's Constitution, Code of Conduct or dispute resolution processes, which also apply to members.`,
        },
        {
          type: "paragraph",
          text: `This policy is not legal advice. It must be reviewed and approved by an authorised Fusion representative before publication.`,
        },
      ],
    },
  ],
  approval: ownerAuthorisedApproval,
};

export const termsOfUse: LegalDocument = {
  slug: "terms",
  title: "Engage Terms of Use",
  shortTitle: "Terms of Use",
  description:
    "The rules for browsing and taking part in Engage, Fusion Party Australia's member participation and governance platform.",
  version: "1.0 (owner-authorised; publication pending)",
  status: "Owner authorised · publication pending",
  publicationStatus: "owner-authorised",
  effectiveDate: "To be set by the release owner on publication",
  operator: "FUSION POLITICAL PARTY INCORPORATED",
  abn: "20 845 177 664",
  registeredPartyName: "votefusion.org for big ideas",
  registeredPartyAbbreviation: "votefusion.org",
  address: "254 McLeod Lane, Mansfield VIC 3722",
  contact: "contact@fusionparty.org.au",
  lastUpdated: "8 November 2026",
  sections: [
    {
      id: "operator",
      number: "1",
      title: "Who operates Engage",
      blocks: [
        {
          type: "paragraph",
          text: `Engage is operated by FUSION POLITICAL PARTY INCORPORATED (ABN 20 845 177 664). Fusion Party Australia is the public name used in Engage (Fusion, we, us). The party is currently registered with the [Australian Electoral Commission](https://www.aec.gov.au/parties_and_representatives/party_registration/Registered_parties/) as "votefusion.org for big ideas" (registered abbreviation "votefusion.org"). Engage is provided for Fusion's members and the public. It is not a government service.`,
        },
        {
          type: "paragraph",
          text: `Contact: [contact@fusionparty.org.au](mailto:contact@fusionparty.org.au). Legal correspondence: 254 McLeod Lane, Mansfield VIC 3722.`,
        },
      ],
    },
    {
      id: "these-terms",
      number: "2",
      title: "When these terms apply",
      blocks: [
        {
          type: "paragraph",
          text: `These terms govern your use of Engage. If you create an account, sign in or participate, you must accept these terms and the [Privacy Policy](/privacy/). Public browsing is subject to the acceptable-use, intellectual-property and liability provisions of these terms, but Fusion does not treat merely viewing a public page as affirmative acceptance of a contract. If you do not agree to these terms, do not create an account, sign in or participate.`,
        },
        {
          type: "callout",
          title: "Acceptance mechanism is implemented but not active",
          text: `Engage has a server-side acceptance mechanism that records the accepted Terms version, content hash, Privacy Policy version and acceptance time. It is intentionally inactive until these documents are published with an effective date and the participation endpoints enforce it. Existing sessions and votes are unaffected. Public browsing alone does not create an account or an affirmative agreement.`,
          tone: "info",
        },
        {
          type: "paragraph",
          text: `These terms apply to the extent permitted by law. They do not exclude or limit any right or guarantee that cannot lawfully be excluded or limited, including under the Australian Consumer Law if it applies.`,
        },
        {
          type: "paragraph",
          text: `If you use Engage on behalf of another person or organisation, you confirm that you are authorised to do so.`,
        },
      ],
    },
    {
      id: "public-browsing",
      number: "3",
      title: "Public browsing and restricted content",
      blocks: [
        {
          type: "paragraph",
          text: `Anyone can read public proposals, published policy, recognised branch information and aggregate vote counts. Some content is restricted to members, branches or administrators. You must not attempt to access restricted content, bypass access controls or use another person's account.`,
        },
        {
          type: "paragraph",
          text: `Public content may include members' display names, contributions and proposal authorship. Email addresses are not displayed publicly.`,
        },
      ],
    },
    {
      id: "accounts",
      number: "4",
      title: "Accounts, eligibility and membership verification",
      blocks: [
        {
          type: "paragraph",
          text: `You need an account to contribute, propose or vote. You must be eligible for Fusion membership under Fusion's rules, including any minimum age requirement those rules set.`,
        },
        {
          type: "paragraph",
          text: `Sign-in uses an email link, and Google if Fusion has enabled it. You must use your own email address and give your full name. Do not impersonate anyone or use a false identity to obtain access.`,
        },
        {
          type: "paragraph",
          text: `Fusion verifies membership manually. Verification can take time. A pending or suspended account can browse but cannot participate.`,
        },
        {
          type: "paragraph",
          text: `You must keep your email account secure. Anyone with access to your email may be able to sign in to Engage. Tell us immediately if you suspect unauthorised access.`,
        },
        {
          type: "paragraph",
          text: `Use one account per person. Do not create accounts to evade a restriction, impersonate someone, or manipulate participation or a ballot.`,
        },
        {
          type: "paragraph",
          text: `We may refuse, suspend or disable an account as described in section 10.`,
        },
      ],
    },
    {
      id: "conduct",
      number: "5",
      title: "Respectful participation and acceptable use",
      blocks: [
        {
          type: "paragraph",
          text: `Engage is a party governance space, not a general social network. Robust debate and disagreement are allowed. These rules target conduct, not opinions.`,
        },
        { type: "paragraph", text: `You must not use Engage to:` },
        {
          type: "list",
          items: [
            `break the law or encourage others to do so;`,
            `harass, bully, threaten, intimidate or discriminate against anyone;`,
            `publish another person's private or personal information without their consent, including doxxing;`,
            `impersonate a person or organisation, or misrepresent your affiliation;`,
            `send spam, bulk unsolicited messages or repetitive content;`,
            `use automated means to access, copy or harvest content in a way that is excessive, disruptive, bypasses access controls or collects personal information without consent;`,
            `probe, scan, overload, disrupt or attempt to breach the security of Engage;`,
            `manipulate a ballot, create multiple accounts, coerce votes or offer a benefit for a vote;`,
            `upload malware or unlawful, infringing or harmful content;`,
            `advertise or promote commercial products or services without Fusion's permission;`,
            `misuse another person's information or attempt to re-identify anonymised or aggregated data.`,
          ],
        },
        {
          type: "paragraph",
          text: `Public governance information is intended to be discoverable, accessible and available for reasonable research and reuse, subject to these terms and applicable law. Nothing in these terms is intended to prohibit reasonable indexing of public pages not marked noindex, accessibility tools, or limited research access to public governance information. Automated access must not place an unreasonable load on Engage, bypass access controls, harvest personal information or reproduce content in a misleading way. Pages marked noindex should not be indexed. This paragraph does not grant a right to reproduce personal information or to present proposal content as official adopted policy.`,
        },
        {
          type: "paragraph",
          text: `Fusion may remove content or restrict participation as described in section 10.`,
        },
      ],
    },
    {
      id: "your-content",
      number: "6",
      title: "Your content",
      blocks: [
        {
          type: "paragraph",
          text: `You retain ownership of the content you submit. Nothing in these terms transfers your copyright to Fusion.`,
        },
        {
          type: "paragraph",
          text: `You grant Fusion a non-exclusive, royalty-free, worldwide licence to store, reproduce, publish, display, adapt and archive your content as needed to operate Engage, conduct governance, maintain records and publish adopted policy. This licence ends when the content is deleted, except for records Fusion must keep for governance, legal or audit purposes.`,
        },
        {
          type: "paragraph",
          text: `You confirm that you have the rights needed to submit the content and that it does not infringe another person's rights. Do not submit confidential information or another person's personal information without consent.`,
        },
        {
          type: "paragraph",
          text: `Your display name is published with your contributions and proposals. Your email address is not published. Your display name is recorded at the time you submit content, and changing your account name later does not rewrite historical records.`,
        },
        {
          type: "paragraph",
          text: `If you delete content, it may remain in backups or governance records as described in the [Privacy Policy](/privacy/).`,
        },
      ],
    },
    {
      id: "proposals",
      number: "7",
      title: "Proposals, comments and amendments",
      blocks: [
        {
          type: "paragraph",
          text: `Verified members can submit proposals, comments, wording suggestions and formal amendments. Submissions are subject to eligibility, moderation and the lifecycle rules shown on the proposal page.`,
        },
        {
          type: "paragraph",
          text: `A proposal is not adopted policy. Its wording may change during deliberation. Once a ballot opens, its substantive wording is locked to a saved revision.`,
        },
        {
          type: "paragraph",
          text: `A wording suggestion is informal. A formal amendment is a recorded change against a specific revision. Seconding formal motions is not yet implemented. The How It Works page describes the current limits, and you should not assume that a seconding process is available.`,
        },
        {
          type: "paragraph",
          text: `Fusion may edit proposal metadata, change a proposal's stage, archive or delete a proposal, or decline to progress a proposal or amendment as described in section 10. Where the system records it, substantive wording remains available in revision history.`,
        },
        {
          type: "paragraph",
          text: `Do not submit content that you do not have permission to publish.`,
        },
      ],
    },
    {
      id: "voting",
      number: "8",
      title: "Voting eligibility and restrictions",
      blocks: [
        {
          type: "paragraph",
          text: `Voting is limited to verified members and, for branch-scoped ballots, active members of the relevant recognised branch. Signing in alone does not give you a vote.`,
        },
        {
          type: "paragraph",
          text: `Each eligible member may cast one vote per ballot. You may change your vote while the ballot is open; the latest recorded vote counts.`,
        },
        {
          type: "paragraph",
          text: `Votes are bound to the exact wording revision shown when the ballot opened. Later edits do not change how your vote is counted.`,
        },
        {
          type: "paragraph",
          text: `Your vote and optional reason are stored with your member identifier and display name. They are not shown publicly, but national administrators can identify them. Voting is not anonymous. A branch administrator who is not also a national administrator does not receive identifiable ballot records through Engage, and moderators do not receive them.`,
        },
        {
          type: "callout",
          title: "Voting is identifiable to national administrators",
          text: `National administrators can access identifiable ballot records, including your member identifier, display name, choice and optional reason. Do not vote or write a reason on the assumption that your choice is anonymous or secret.`,
          tone: "warning",
        },
        {
          type: "paragraph",
          text: `Do not coerce, buy or trade votes, or vote on behalf of someone else.`,
        },
        {
          type: "paragraph",
          text: `Administrators with the relevant role and branch scope have technical controls that can close a ballot or change its stage, and can review how a ballot is bound to wording. These controls exist to preserve ballot integrity. They are not a complete contingency policy: the grounds, approval requirements, member notice and escalation steps for using them have not yet been adopted. Fusion must establish and publish those rules before relying on them for a contested ballot. This is an outstanding governance decision for Fusion.`,
        },
        {
          type: "paragraph",
          text: `A successful vote is not adoption. See section 9.`,
        },
      ],
    },
    {
      id: "results",
      number: "9",
      title: "Results, ratification and adopted policy",
      blocks: [
        {
          type: "paragraph",
          text: `Engage records votes and aggregate tallies. It does not calculate or apply a passing threshold. An authorised administrator records the result using Fusion's rules. Aggregate tallies are public and, in a very small ballot, may effectively reveal how a small number of voters voted.`,
        },
        {
          type: "paragraph",
          text: `A recorded successful result is not adopted policy. Formal ratification by an authorised Fusion authority and authorised publication are separate steps.`,
        },
        {
          type: "paragraph",
          text: `Only published policy in the Policy Registry is presented as official adopted wording. Proposals, ballot results and implementation notes are not official policy.`,
        },
        {
          type: "paragraph",
          text: `Ratification and publication records identify the decision event and the exact revision.`,
        },
        {
          type: "paragraph",
          text: `Fusion may withdraw or supersede published policy. Historical records may remain visible with their status.`,
        },
      ],
    },
    {
      id: "moderation",
      number: "10",
      title: "Moderation and administrative actions",
      blocks: [
        {
          type: "paragraph",
          text: `Fusion may take the following actions where reasonably necessary to operate Engage, protect members, maintain integrity or comply with the law:`,
        },
        {
          type: "list",
          items: [
            `remove content, or edit proposal content where the platform allows;`,
            `restrict or disable an account;`,
            `suspend or revoke membership or branch access;`,
            `change a proposal's stage, archive it or delete it;`,
            `close a ballot or change its stage using the available administrative controls;`,
            `record, review or decline to record a ballot result;`,
            `decline to progress a proposal or amendment.`,
          ],
        },
        {
          type: "paragraph",
          text: `Where practicable, Fusion will explain the action and the reason. Some actions may be urgent or confidential.`,
        },
        {
          type: "paragraph",
          text: `These terms do not create a right to a particular moderation process. Fusion's Constitution, Code of Conduct and dispute resolution processes apply to party membership and discipline. Platform moderation decisions do not replace those processes.`,
        },
        {
          type: "paragraph",
          text: `You can report content or conduct to [contact@fusionparty.org.au](mailto:contact@fusionparty.org.au). Do not attempt to evade a restriction by creating another account.`,
        },
      ],
    },
    {
      id: "records",
      number: "11",
      title: "Record integrity and immutable revisions",
      blocks: [
        {
          type: "paragraph",
          text: `Engage keeps saved wording snapshots, content hashes, ballot revisions and audit events so that decisions can be audited.`,
        },
        {
          type: "paragraph",
          text: `Once a ballot opens, substantive wording is locked. Earlier revisions remain available. Votes are tied to the revision current at the time.`,
        },
        {
          type: "paragraph",
          text: `Some records cannot be edited or deleted through the application, including vote records, ballot results, ratification and publication events, audit events and legal acceptance records. This is intentional.`,
        },
        {
          type: "paragraph",
          text: `If you believe a record is factually wrong, contact us. Fusion may add a correction or note rather than erase the original.`,
        },
      ],
    },
    {
      id: "availability",
      number: "12",
      title: "Availability and technical failures",
      blocks: [
        {
          type: "paragraph",
          text: `Engage is provided on an "as available" basis. We aim to keep it available but do not guarantee uninterrupted or error-free service.`,
        },
        {
          type: "paragraph",
          text: `We may suspend access for maintenance, security, integrity reviews or events outside our control.`,
        },
        {
          type: "paragraph",
          text: `If a technical failure affects a ballot, administrators may use the available controls to close the ballot, change its stage or preserve recorded votes. The formal grounds, safeguards, member notice and escalation requirements for those interventions are not yet established. This is an outstanding governance decision for Fusion.`,
        },
        {
          type: "paragraph",
          text: `To the extent permitted by law, Fusion is not liable for indirect or consequential loss arising from unavailable or interrupted service. Nothing in these terms excludes or limits any right or guarantee that cannot lawfully be excluded or limited, including under the Australian Consumer Law if it applies.`,
        },
        {
          type: "paragraph",
          text: `You are responsible for keeping your own copies of content you want to retain.`,
        },
      ],
    },
    {
      id: "privacy",
      number: "13",
      title: "Privacy",
      blocks: [
        {
          type: "paragraph",
          text: `Our [Privacy Policy](/privacy/) explains how we handle personal information and forms part of these terms.`,
        },
        {
          type: "paragraph",
          text: `Key points: your display name is public with your contributions; your email address is not public; national administrators can identify your votes; and governance records may be retained.`,
        },
      ],
    },
    {
      id: "changes",
      number: "14",
      title: "Changes to Engage and these terms",
      blocks: [
        {
          type: "paragraph",
          text: `We may change, suspend or discontinue features. We may update these terms.`,
        },
        {
          type: "paragraph",
          text: `We will publish the new version and effective date. If changes materially affect your rights, we will take reasonable steps to notify you before they apply. For account holders, continued use after the effective date may be treated as acceptance where the law permits and where Fusion has given notice. Public browsing alone is not treated as acceptance.`,
        },
        {
          type: "paragraph",
          text: `Changes do not apply retrospectively to governance records.`,
        },
      ],
    },
    {
      id: "governance",
      number: "15",
      title: "Organisational governance rules",
      blocks: [
        {
          type: "paragraph",
          text: `Engage supports Fusion's governance but does not replace the Constitution, Code of Conduct or decisions of authorised party bodies.`,
        },
        {
          type: "paragraph",
          text: `If there is a conflict between these terms and the Constitution or a lawful decision of an authorised party body about party governance, the Constitution or decision prevails to the extent of the conflict. These terms continue to govern your use of the platform.`,
        },
        {
          type: "paragraph",
          text: `References to proposals, ballots, ratification and publication describe the platform workflow. They do not create governance authority or change Fusion's rules.`,
        },
        {
          type: "paragraph",
          text: `Seconding, automatic ratification, timed ballots and other proposed features are not implemented unless the How It Works page says they are available.`,
        },
      ],
    },
    {
      id: "disputes",
      number: "16",
      title: "Disputes and contact",
      blocks: [
        {
          type: "paragraph",
          text: `If you have a concern about Engage, contact [contact@fusionparty.org.au](mailto:contact@fusionparty.org.au) first. We will try to resolve it. Legal correspondence: 254 McLeod Lane, Mansfield VIC 3722.`,
        },
        {
          type: "paragraph",
          text: `For complaints about member conduct, Fusion's Code of Conduct and Dispute Resolution Committee process may apply. Contact us for the current process and contact details.`,
        },
        {
          type: "paragraph",
          text: `For privacy complaints, see the [Privacy Policy](/privacy/).`,
        },
        {
          type: "paragraph",
          text: `These terms are governed by the laws of Victoria, Australia. The courts of Victoria have jurisdiction. Nothing prevents you from exercising rights under Australian law.`,
        },
        {
          type: "paragraph",
          text: `If any provision is invalid, the rest remains in effect. A failure to enforce a provision is not a waiver.`,
        },
      ],
    },
  ],
  approval: ownerAuthorisedApproval,
};

export const legalDocuments = [privacyPolicy, termsOfUse] as const;

export function legalDocumentBySlug(slug: string): LegalDocument | null {
  return legalDocuments.find((document) => document.slug === slug) ?? null;
}
