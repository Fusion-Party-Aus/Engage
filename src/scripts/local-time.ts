const formatLocalTimes = () => {
  document.querySelectorAll<HTMLElement>('time[datetime]').forEach((element) => {
    const raw = element.getAttribute('datetime');
    if (!raw) return;
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) return;
    const dateStyle = element.dataset.dateStyle;
    const timeStyle = element.dataset.timeStyle;
    const options: Intl.DateTimeFormatOptions = {
      day: 'numeric',
      month: 'short',
      ...(dateStyle === 'long' ? { year: 'numeric' as const } : {}),
      ...(dateStyle === 'medium' ? { year: 'numeric' as const } : {}),
      ...(timeStyle ? { hour: 'numeric' as const, minute: '2-digit' as const } : {}),
    };
    if (dateStyle === 'long') options.month = 'long';
    if (dateStyle === 'medium') options.month = 'short';
    element.textContent = new Intl.DateTimeFormat(undefined, options).format(date);
    element.title = new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'short' }).format(date);
  });
};

formatLocalTimes();
document.addEventListener('astro:page-load', formatLocalTimes);
