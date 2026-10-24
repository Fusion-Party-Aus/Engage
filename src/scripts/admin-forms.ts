/** Native forms call the existing JSON contracts; this does not define workflows. */
export function bindAdminForms() {
  for (const form of document.querySelectorAll<HTMLFormElement>('form[data-admin-api]')) {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      const out = form.querySelector<HTMLElement>('[role="status"]')!;
      const button = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
      button.disabled = true;
      out.textContent = 'Saving…';
      try {
        const payload: Record<string, unknown> = {};
        for (const [key, value] of new FormData(form)) {
          const text = String(value).trim();
          if (key === 'outcomes') payload[key] = text.split('\n').map(line => line.trim()).filter(Boolean);
          else if (key === 'policyIds') payload[key] = new FormData(form).getAll(key).map(String);
          else if (key === 'opensAt' || key === 'closesAt') payload[key] = new Date(text).toISOString();
          else if (['programme', 'pillar', 'editorialHeading', 'domain'].includes(key)) payload[key] = text || null;
          else payload[key] = text;
        }
        const response = await fetch(form.dataset.adminApi!, { method: form.dataset.method ?? 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error ?? 'Could not save. Please retry.');
        out.replaceChildren(document.createTextNode('Saved. '));
        const link = document.createElement('a');
        link.href = data.policy?.policyId ? `/admin/policies/${encodeURIComponent(data.policy.policyId)}/` : window.location.href;
        link.textContent = data.policy?.policyId ? 'Open policy workspace' : 'Refresh to see the updated record';
        if (!data.policy?.policyId) link.addEventListener('click', event => { event.preventDefault(); window.location.reload(); });
        out.append(link);
      } catch (error) {
        out.textContent = error instanceof Error ? error.message : 'Could not save. Please retry.';
      } finally { button.disabled = false; }
    });
  }
}
