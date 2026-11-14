/**
 * Shared behaviour for the two admin forms that record a formal ballot outcome
 * (`/admin/proposals/` and `/admin/proposals/[slug]/`).
 *
 * The computed outcome is rendered by the server from the ballot tally (D8, D9,
 * D10/O1). This module keeps the officer's task legible before submission: the
 * override reason is revealed and required only when the chosen result
 * contradicts that computed outcome. The server still decides and records.
 */
export interface BallotResultPayload {
  proposalId: string | undefined;
  result: string;
  decisionEventId: string;
  overrideReason?: string;
}

export function syncBallotOutcomeOverride(
  form: HTMLFormElement,
  options: { focus?: boolean } = {},
): void {
  const computedResult = form.dataset.computedResult ?? "";
  const select = form.querySelector<HTMLSelectElement>('select[name="result"]');
  const field = form.querySelector<HTMLElement>("[data-override-field]");
  const reason = form.querySelector<HTMLTextAreaElement>(
    'textarea[name="overrideReason"]',
  );
  const announcement = form.querySelector<HTMLElement>(
    "[data-override-announcement]",
  );
  if (!select || !field || !reason || !computedResult) return;

  const contradicts =
    Boolean(select.value) && select.value !== computedResult;
  const wasHidden = field.hidden;
  field.hidden = !contradicts;
  reason.required = contradicts;
  if (contradicts) {
    if (announcement && wasHidden) {
      announcement.textContent =
        "The selected outcome differs from the votes. A written reason is required.";
    }
    if (options.focus && wasHidden) reason.focus();
  } else {
    reason.value = "";
    if (announcement) announcement.textContent = "";
  }
}

export function wireBallotOutcomeForm(form: HTMLFormElement): void {
  const select = form.querySelector<HTMLSelectElement>('select[name="result"]');
  select?.addEventListener("change", () =>
    syncBallotOutcomeOverride(form, { focus: true }),
  );
  syncBallotOutcomeOverride(form);
}

export function ballotResultPayload(
  form: HTMLFormElement,
  fields: Pick<FormData, "get"> = new FormData(form),
): BallotResultPayload {
  const overrideReason = String(fields.get("overrideReason") ?? "").trim();
  return {
    proposalId: form.dataset.proposalId,
    result: String(fields.get("result") ?? ""),
    decisionEventId: String(fields.get("decisionEventId") ?? ""),
    ...(overrideReason ? { overrideReason } : {}),
  };
}
