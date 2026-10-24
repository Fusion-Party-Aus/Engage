const fields = new Set(["version", "title", "statement", "details", "outcomes", "domain", "changeSummary"]);

function cleanString(value, minimum, maximum) {
  if (typeof value !== "string") return null;
  const cleaned = value.trim();
  return cleaned.length >= minimum && cleaned.length <= maximum ? cleaned : null;
}

export function validatePolicyRevisionInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { error: "Provide a policy revision object." };
  if (Object.keys(value).some((key) => !fields.has(key))) return { error: "The revision contains unsupported fields." };
  const version = cleanString(value.version, 1, 80);
  if (!version || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(version)) return { error: "Version must use letters, numbers, dots, hyphens, or underscores." };
  const title = cleanString(value.title, 3, 200);
  const statement = cleanString(value.statement, 10, 2_000);
  const details = cleanString(value.details, 10, 24_000);
  if (!title || !statement || !details) return { error: "Title, statement, and details must contain valid text within their size limits." };
  if (!Array.isArray(value.outcomes) || value.outcomes.length < 1 || value.outcomes.length > 15) return { error: "Provide between 1 and 15 policy outcomes." };
  const outcomes = value.outcomes.map((outcome) => cleanString(outcome, 1, 500));
  if (outcomes.some((outcome) => outcome === null) || outcomes.reduce((total, outcome) => total + (outcome?.length ?? 0), 0) > 6_000) return { error: "Each outcome must be at most 500 characters and total outcomes at most 6,000 characters." };
  let domain;
  if (value.domain !== undefined) {
    domain = cleanString(value.domain, 1, 120);
    if (!domain) return { error: "Domain must be at most 120 characters." };
  }
  let changeSummary;
  if (value.changeSummary !== undefined && value.changeSummary !== "") {
    changeSummary = cleanString(value.changeSummary, 1, 1000);
    if (!changeSummary) return { error: "Change summary must be at most 1,000 characters." };
  }
  return { value: { version, title, statement, details, outcomes, ...(domain ? { domain } : {}), ...(changeSummary ? { changeSummary } : {}) } };
}

export function validPolicyId(policyId) {
  return typeof policyId === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{1,99}$/.test(policyId);
}
