import type { PlatformEnv, RuntimeLocals } from "./types";

export function platformEnv(locals: RuntimeLocals): PlatformEnv {
  return locals.runtime?.env ?? locals.env ?? {};
}

export function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

export function requireSameOrigin(request: Request): Response | null {
  const origin = request.headers.get("origin");
  if (!origin) return json({ error: "A same-origin request is required." }, 403);
  try {
    if (new URL(origin).origin !== new URL(request.url).origin) return json({ error: "A same-origin request is required." }, 403);
    return null;
  } catch {
    return json({ error: "A valid request origin is required." }, 403);
  }
}

export async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) return null;
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > 32_768) return null;
  try {
    const value: unknown = await request.json();
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}
