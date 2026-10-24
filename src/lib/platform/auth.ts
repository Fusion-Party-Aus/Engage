import { getDatabase } from "./database.ts";
import type { PlatformEnv, PlatformIdentity, PlatformRole } from "./types.ts";

const SESSION_COOKIE = "horizon_preview_session";
const SESSION_SECONDS = 60 * 60 * 8;

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function fromBase64Url(value: string): Uint8Array {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function hmacKey(secret: string, usage: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, usage);
}

function cookieValue(request: Request, name: string): string | null {
  const cookies = request.headers.get("cookie")?.split(";") ?? [];
  const match = cookies.map((cookie) => cookie.trim()).find((cookie) => cookie.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

function previewMembers(env: PlatformEnv): string[] {
  const fromEnv = env.PREVIEW_MEMBER_IDS?.split(",").map((id) => id.trim()).filter(Boolean);
  const adminId = env.PREVIEW_ADMIN_ID ?? "preview-admin-01";
  return [...new Set([...(fromEnv?.length ? fromEnv : ["preview-member-01", "preview-member-02"]), adminId])];
}

function previewAdminId(env: PlatformEnv): string {
  return env.PREVIEW_ADMIN_ID ?? "preview-admin-01";
}

export async function createPreviewSessionCookie(memberId: string, env: PlatformEnv, secure = false): Promise<string> {
  if (env.APP_MODE !== "preview") throw new Error("Synthetic authentication is disabled outside preview mode.");
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) throw new Error("Preview session signing is not configured.");
  if (!previewMembers(env).includes(memberId)) throw new Error("Unknown synthetic member.");
  const payload = base64Url(new TextEncoder().encode(JSON.stringify({ sub: memberId, exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS })));
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(env.SESSION_SECRET, ["sign"]), new TextEncoder().encode(payload)));
  const secureFlag = secure ? " Secure;" : "";
  return `${SESSION_COOKIE}=${encodeURIComponent(`${payload}.${base64Url(signature)}`)}; Path=/; HttpOnly;${secureFlag} SameSite=Lax; Max-Age=${SESSION_SECONDS}`;
}

async function verifyPreviewSession(request: Request, env: PlatformEnv): Promise<PlatformIdentity | null> {
  if (env.APP_MODE !== "preview" || !env.SESSION_SECRET || env.SESSION_SECRET.length < 32) return null;
  const token = cookieValue(request, SESSION_COOKIE);
  if (!token) return null;
  const [payload, signature, ...extra] = token.split(".");
  if (!payload || !signature || extra.length) return null;
  try {
    const signatureBytes = new Uint8Array(fromBase64Url(signature));
    const payloadBytes = new Uint8Array(new TextEncoder().encode(payload));
    const valid = await crypto.subtle.verify("HMAC", await hmacKey(env.SESSION_SECRET, ["verify"]), signatureBytes, payloadBytes);
    if (!valid) return null;
    const session = JSON.parse(new TextDecoder().decode(fromBase64Url(payload))) as { sub?: string; exp?: number };
    if (!session.sub || !session.exp || session.exp < Date.now() / 1000) return null;
    if (!previewMembers(env).includes(session.sub)) return null;
    const roles: PlatformRole[] = ["member"];
    if (session.sub === previewAdminId(env)) roles.push("administrator", "moderator");
    return { memberId: session.sub, source: "synthetic", roles };
  } catch {
    return null;
  }
}

export interface IdentityResolution {
  identity: PlatformIdentity | null;
  unavailableReason?: "authentication_unavailable";
}

/** Better Auth's durable user ID is the application's stable member ID. */
export async function resolveIdentity(request: Request, env: PlatformEnv): Promise<IdentityResolution> {
  if (env.APP_MODE === "preview") return { identity: await verifyPreviewSession(request, env) };
  const { getAuth, loginConfigured } = await import("./better-auth.ts");
  if (!loginConfigured(env)) return { identity: null };
  const session = await (await getAuth(env)).api.getSession({ headers: request.headers });
  if (!session) return { identity: null };
  const identity: PlatformIdentity = { memberId: session.user.id, source: "engage", roles: [] };
  identity.roles = await platformRoles(identity, env);
  return { identity };
}

export async function platformRoles(identity: PlatformIdentity, env: PlatformEnv): Promise<PlatformRole[]> {
  if (identity.source === "synthetic") return identity.roles;
  const db = await getDatabase(env);
  const roles = await db.collection<{ role: PlatformRole }>("application_roles").find({ memberId: identity.memberId }).project<{ role: PlatformRole }>({ role: 1, _id: 0 }).toArray();
  return roles.map(({ role }) => role);
}

export const previewSessionCookieName = SESSION_COOKIE;
