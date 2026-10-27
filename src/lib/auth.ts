import { betterAuth } from "better-auth";
import { mongodbAdapter } from "@better-auth/mongo-adapter";
import { magicLink } from "better-auth/plugins";
import { createAuthMiddleware, APIError } from "better-auth/api";
import { ObjectId, type Db } from "mongodb";
import { getDatabase } from "./db.ts";
import type { MembershipStatus, PlatformEnv, SessionUser, UserRole } from "./types.ts";

const DEV_COOKIE = "engage_dev_user";

export function validPersonName(value: unknown): string | null {
  const name = typeof value === "string" ? value.trim() : "";
  return name.length >= 2 && name.length <= 100 ? name : null;
}

export function isProduction(env: PlatformEnv): boolean {
  return env.APP_MODE === "production";
}

export function googleLoginConfigured(env: PlatformEnv): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}

export function emailLoginConfigured(env: PlatformEnv): boolean {
  return Boolean(env.RESEND_API_KEY && env.AUTH_EMAIL_FROM);
}

export function loginConfigured(env: PlatformEnv): boolean {
  return Boolean(
    env.MONGODB_URI &&
      env.MONGODB_DB_NAME &&
      env.BETTER_AUTH_URL &&
      env.BETTER_AUTH_SECRET &&
      env.BETTER_AUTH_SECRET.length >= 32 &&
      (googleLoginConfigured(env) || emailLoginConfigured(env)),
  );
}

export async function getAuth(env: PlatformEnv) {
  if (!loginConfigured(env)) {
    throw new Error("Member sign-in is not configured.");
  }
  const db = await getDatabase(env);
  return createEngageAuth(db, env);
}

export function createEngageAuth(db: Db, env: PlatformEnv) {
  return betterAuth({
    appName: "Engage",
    baseURL: env.BETTER_AUTH_URL!,
    secret: env.BETTER_AUTH_SECRET!,
    database: mongodbAdapter(db, { transaction: false }),
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path === "/sign-in/magic-link" && typeof ctx.body?.email === "string") {
          const existing = await db.collection("user").findOne({ email: ctx.body.email.trim().toLowerCase() });
          if (!validPersonName(existing?.name) && !validPersonName(ctx.body?.name)) {
            throw new APIError("BAD_REQUEST", {
              code: "NAME_REQUIRED",
              message: "Enter your full name for your first sign-in.",
            });
          }
        }
        if (ctx.path === "/update-user" && ctx.body?.name !== undefined && !validPersonName(ctx.body.name)) {
          throw new APIError("BAD_REQUEST", { message: "Enter a full name (2–100 characters)." });
        }
      }),
    },
    databaseHooks: {
      session: {
        create: {
          before: async (session) => {
            const account = await db.collection("user").findOne({ _id: new ObjectId(session.userId) });
            if (account?.disabled === true) {
              throw new APIError("FORBIDDEN", {
                message: "This account is disabled. Contact an administrator.",
              });
            }
          },
        },
      },
    },
    socialProviders: googleLoginConfigured(env)
      ? { google: { clientId: env.GOOGLE_CLIENT_ID!, clientSecret: env.GOOGLE_CLIENT_SECRET! } }
      : {},
    plugins: emailLoginConfigured(env)
      ? [
          magicLink({
            expiresIn: 600,
            storeToken: "hashed",
            rateLimit: { window: 60, max: 5 },
            sendMagicLink: async ({ email, url }) => {
              const safeUrl = url
                .replaceAll("&", "&amp;")
                .replaceAll('"', "&quot;")
                .replaceAll("<", "&lt;")
                .replaceAll(">", "&gt;");
              const response = await fetch("https://api.resend.com/emails", {
                method: "POST",
                headers: {
                  authorization: `Bearer ${env.RESEND_API_KEY}`,
                  "content-type": "application/json",
                },
                body: JSON.stringify({
                  from: env.AUTH_EMAIL_FROM,
                  to: [email],
                  subject: "Your Engage sign-in link",
                  text: `Sign in to Engage:\n\n${url}\n\nThis link expires in 10 minutes and can be used once. If you did not request it, ignore this email.`,
                  html: `<p><a href="${safeUrl}">Sign in to Engage</a></p><p>This link expires in 10 minutes and can be used once.</p><p>If you did not request it, ignore this email.</p>`,
                }),
                signal: AbortSignal.timeout(10_000),
              });
              if (!response.ok || typeof (await response.json()).id !== "string") {
                throw new Error("Sign-in email could not be sent.");
              }
            },
          }),
        ]
      : [],
    rateLimit: { enabled: true, storage: "database" },
    account: { accountLinking: { enabled: false, disableImplicitLinking: true } },
    session: { cookieCache: { enabled: false } },
  });
}

function parseCookie(request: Request, name: string): string | null {
  const cookies = request.headers.get("cookie")?.split(";") ?? [];
  for (const part of cookies) {
    const trimmed = part.trim();
    if (trimmed.startsWith(`${name}=`)) {
      return decodeURIComponent(trimmed.slice(name.length + 1));
    }
  }
  return null;
}

export function createDevSessionCookie(role: "member" | "administrator"): string {
  return `${DEV_COOKIE}=${encodeURIComponent(role)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=28800`;
}

export function clearDevSessionCookie(): string {
  return `${DEV_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export async function getSessionUser(request: Request, env: PlatformEnv): Promise<SessionUser | null> {
  if (!isProduction(env)) {
    const devRole = parseCookie(request, DEV_COOKIE);
    if (devRole === "member" || devRole === "administrator") {
      const isAdmin = devRole === "administrator";
      return {
        memberId: isAdmin ? "dev-admin-01" : "dev-member-01",
        name: isAdmin ? "Local Administrator" : "Local Verified Member",
        email: isAdmin ? "admin@local.test" : "member@local.test",
        role: isAdmin ? "administrator" : "member",
        status: "verified",
        canParticipate: true,
        isStaff: isAdmin,
        isAdmin,
      };
    }
  }

  if (!loginConfigured(env)) return null;

  try {
    const auth = await getAuth(env);
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user?.id) return null;

    const db = await getDatabase(env);
    const memberId = session.user.id;
    const account = await db
      .collection("user")
      .findOne({ _id: new ObjectId(memberId) });
    if (!account || account.disabled === true) return null;

    const [rolesDocs, membershipDoc] = await Promise.all([
      db.collection<{ role: UserRole }>("application_roles").find({ memberId }).toArray(),
      db.collection<{ status: MembershipStatus }>("memberships").findOne({ memberId }),
    ]);

    const roles = rolesDocs.map((r) => r.role);
    const role: UserRole = roles.includes("administrator")
      ? "administrator"
      : roles.includes("moderator")
        ? "moderator"
        : "member";
    const status: MembershipStatus = membershipDoc?.status ?? "pending";

    return {
      memberId,
      name: String(account.name || session.user.name || ""),
      email: String(account.email || session.user.email || ""),
      role,
      status,
      canParticipate: status === "verified",
      isStaff: role === "administrator" || role === "moderator",
      isAdmin: role === "administrator",
    };
  } catch {
    return null;
  }
}
