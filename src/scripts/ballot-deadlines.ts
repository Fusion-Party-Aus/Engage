import { formatLocalDeadline, formatRelativeDeadline } from '../lib/ballot-deadline.ts';

export function hydrateBallotDeadlines(root: ParentNode = document) {
  const now = new Date();
  root.querySelectorAll<HTMLTimeElement>('time[data-ballot-deadline]').forEach((time) => {
    if (!time.dateTime) return;
    try {
      const prefix = time.dataset.prefix || 'Voting closes';
      time.textContent = `${prefix} ${formatRelativeDeadline(time.dateTime, now)} · ${formatLocalDeadline(time.dateTime)}`;
    } catch {
      // Keep the server-rendered fallback if the date is invalid.
    }
  });
}
