import { betterAuth } from "better-auth";
import { mongodbAdapter } from "@better-auth/mongo-adapter";
import { getDatabase } from "./database.ts";
import type { PlatformEnv } from "./types.ts";

export function loginConfigured(env: PlatformEnv): boolean {
  return env.APP_MODE === "production" && Boolean(env.MONGODB_URI && env.MONGODB_DB_NAME && env.BETTER_AUTH_URL && env.BETTER_AUTH_SECRET && env.BETTER_AUTH_SECRET.length >= 32 && env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}

export async function getAuth(env: PlatformEnv) {
  if (!loginConfigured(env)) throw new Error("Google sign-in is not configured.");
  return createEngageAuth(await getDatabase(env), env);
}

export function createEngageAuth(db: import("mongodb").Db, env: PlatformEnv) {
  return betterAuth({
    appName: "Engage",
    baseURL: env.BETTER_AUTH_URL!,
    secret: env.BETTER_AUTH_SECRET!,
    database: mongodbAdapter(db, { transaction: false }),
    socialProviders: { google: { clientId: env.GOOGLE_CLIENT_ID!, clientSecret: env.GOOGLE_CLIENT_SECRET! } },
    account: { accountLinking: { enabled: false, disableImplicitLinking: true } },
    session: { cookieCache: { enabled: false } },
  });
}
