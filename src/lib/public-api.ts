export async function publicJson(
  request: Request,
  data: unknown,
  options: { maxAge?: number; immutable?: boolean; canonical?: string } = {},
): Promise<Response> {
  const body = JSON.stringify(data);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(body),
  );
  const etag = `W/"${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}"`;
  const cache = options.immutable
    ? "public, max-age=31536000, immutable"
    : `public, max-age=${options.maxAge ?? 60}, stale-while-revalidate=300`;
  const headers = new Headers({
    "content-type": "application/json",
    "cache-control": cache,
    etag,
  });
  const canonical = options.canonical ?? new URL(request.url).href;
  headers.set("link", `<${canonical}>; rel="canonical"`);
  if (matchesIfNoneMatch(request.headers.get("if-none-match"), etag))
    return new Response(null, { status: 304, headers });
  return new Response(body, { headers });
}

/** GET/HEAD conditional requests use weak comparison and allow a tag list or wildcard. */
function matchesIfNoneMatch(header: string | null, etag: string): boolean {
  if (!header) return false;
  return header.split(",").some((candidate) => {
    const token = candidate.trim();
    return token === "*" || token.replace(/^W\//, "") === etag.replace(/^W\//, "");
  });
}
