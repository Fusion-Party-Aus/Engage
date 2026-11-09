/** Parse first: slash-prefix checks alone allow backslashes and encoded control characters. */
export function safeMemberReturn(raw: string, fallback = '/member/'): string {
  try {
    if (!raw.startsWith('/') || /[\\\u0000-\u0020]/.test(raw)) return fallback;
    const url=new URL(raw,'https://engage.invalid');
    if (url.origin !== 'https://engage.invalid' || /^\/api(?:\/|$)/i.test(decodeURIComponent(url.pathname))) return fallback;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch { return fallback; }
}
