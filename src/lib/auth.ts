import { betterAuth } from "better-auth";
import { mongodbAdapter } from "@better-auth/mongo-adapter";
import { magicLink } from "better-auth/plugins";
import { createAuthMiddleware, APIError } from "better-auth/api";
import { ObjectId, type Db } from "mongodb";
import { getDatabase } from "./db.ts";
import type {
  MembershipStatus,
  PlatformEnv,
  SessionUser,
  UserRole,
} from "./types.ts";

const DEV_COOKIE = "engage_dev_user";

// Development sign-in is an explicit local/test facility. Unknown or missing
// APP_MODE values fail closed rather than being treated as development.
const DEV_LOGIN_APP_MODES = new Set(["development", "test", "preview"]);

export function validPersonName(value: unknown): string | null {
  const name = typeof value === "string" ? value.trim() : "";
  return name.length >= 2 && name.length <= 100 ? name : null;
}

export function isProduction(env: PlatformEnv): boolean {
  return env.APP_MODE === "production";
}

export function devLoginEnabled(env: PlatformEnv): boolean {
  return DEV_LOGIN_APP_MODES.has(
    String(env.APP_MODE ?? "")
      .trim()
      .toLowerCase(),
  );
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
    // Use one canonical public origin for OAuth and magic-link callbacks.
    trustedOrigins: [env.BETTER_AUTH_URL!],
    advanced: { useSecureCookies: isProduction(env) },
    secret: env.BETTER_AUTH_SECRET!,
    database: mongodbAdapter(db, { transaction: false }),
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (
          ctx.path === "/sign-in/magic-link" &&
          typeof ctx.body?.email === "string"
        ) {
          const existing = await db
            .collection("user")
            .findOne({ email: ctx.body.email.trim().toLowerCase() });
          if (
            !validPersonName(existing?.name) &&
            !validPersonName(ctx.body?.name)
          ) {
            throw new APIError("BAD_REQUEST", {
              code: "NAME_REQUIRED",
              message: "Enter your full name for your first sign-in.",
            });
          }
        }
        if (
          ctx.path === "/update-user" &&
          ctx.body?.name !== undefined &&
          !validPersonName(ctx.body.name)
        ) {
          throw new APIError("BAD_REQUEST", {
            message: "Enter a full name (2–100 characters).",
          });
        }
      }),
    },
    databaseHooks: {
      session: {
        create: {
          before: async (session) => {
            const account = await db
              .collection("user")
              .findOne({ _id: new ObjectId(session.userId) });
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
      ? {
          google: {
            clientId: env.GOOGLE_CLIENT_ID!,
            clientSecret: env.GOOGLE_CLIENT_SECRET!,
          },
        }
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
              if (
                !response.ok ||
                typeof (await response.json()).id !== "string"
              ) {
                throw new Error("Sign-in email could not be sent.");
              }
            },
          }),
        ]
      : [],
    rateLimit: { enabled: true, storage: "database" },
    // An administrator may pre-create a member before they prove their email.
    // Better Auth only links an untrusted provider when it reports a verified,
    // matching email; allow that proof to link the existing member account.
    account: {
      accountLinking: { enabled: true, requireLocalEmailVerified: false },
    },
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

export function createDevSessionCookie(
  role: "member" | "administrator",
): string {
  return `${DEV_COOKIE}=${encodeURIComponent(role)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=28800`;
}

export function clearDevSessionCookie(): string {
  return `${DEV_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function canAdministerBranch(
  user: SessionUser,
  branchId: string,
): boolean {
  return user.isAdmin || Boolean(user.branchAdminIds?.includes(branchId));
}

export function canManageBranchProposal(
  user: SessionUser,
  proposal: { originatingBranchId?: string },
): boolean {
  return (
    user.isAdmin ||
    user.isStaff ||
    Boolean(
      proposal.originatingBranchId &&
      user.branchAdminIds?.includes(proposal.originatingBranchId),
    )
  );
}

export function canManageBranchBallot(
  user: SessionUser,
  proposal: {
    governanceAuthorityBranchId?: string;
    jurisdictionBranchId?: string;
  },
): boolean {
  return (
    user.isAdmin ||
    user.isStaff ||
    Boolean(
      proposal.governanceAuthorityBranchId &&
      proposal.governanceAuthorityBranchId === proposal.jurisdictionBranchId &&
      user.branchAdminIds?.includes(proposal.governanceAuthorityBranchId),
    )
  );
}

/**
 * Identifiable ballot records are restricted to the explicitly authorised
 * role. The current application model has no Election Officer role, so only
 * national administrators may read other members' ballot choices. Moderators
 * are generic staff and must not inherit ballot-identification access.
 *
 * Do not broaden this to `isStaff` without an explicit governance decision
 * defining the officer boundary.
 */
export function canViewIdentifiableBallots(
  user: SessionUser | null | undefined,
): boolean {
  return Boolean(user?.isAdmin);
}

export async function getSessionUser(
  request: Request,
  env: PlatformEnv,
): Promise<SessionUser | null> {
  if (devLoginEnabled(env)) {
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

    const [rolesDocs, membershipDoc, branchMembershipRows] = await Promise.all([
      db
        .collection<{ role: UserRole }>("application_roles")
        .find({ memberId })
        .toArray(),
      db
        .collection<{ status: MembershipStatus }>("memberships")
        .findOne({ memberId }),
      db
        .collection<{ branchId: string; branchRole?: string; status: string }>(
          "branch_memberships",
        )
        .find({ memberId, status: "active" })
        .toArray(),
    ]);

    const roles = rolesDocs.map((r) => r.role);
    const role: UserRole = roles.includes("administrator")
      ? "administrator"
      : roles.includes("moderator")
        ? "moderator"
        : "member";
    const status: MembershipStatus = membershipDoc?.status ?? "pending";
    const activeBranchIds = branchMembershipRows.map((row) => row.branchId);
    const branchAdminIds = branchMembershipRows
      .filter((row) => row.branchRole === "administrator")
      .map((row) => row.branchId);

    return {
      memberId,
      name: String(account.name || session.user.name || ""),
      email: String(account.email || session.user.email || ""),
      role,
      status,
      canParticipate: status === "verified",
      isStaff: role === "administrator" || role === "moderator",
      isAdmin: role === "administrator",
      branchAdminIds,
      isBranchAdmin: branchAdminIds.length > 0,
      activeBranchIds,
    };
  } catch {
    return null;
  }
}
