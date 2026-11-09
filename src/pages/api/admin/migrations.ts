import type { APIRoute } from "astro";
import { getSessionUser } from "../../../lib/auth.ts";
import { getDatabase, runtimeEnv } from "../../../lib/db.ts";
import {
  MigrationError,
  getMigrationStatus,
  previewStandardBranches,
  runAllMigrations,
  runMigration,
} from "../../../lib/migrations.ts";

export const prerender = false;

const headers = { "cache-control": "private, no-store" };

function errorResponse(error: unknown) {
  if (error instanceof MigrationError) {
    return Response.json(
      { error: error.message },
      { status: error.status, headers },
    );
  }
  return Response.json(
    {
      error:
        error instanceof Error
          ? error.message
          : "Could not run this migration.",
    },
    { status: 400, headers },
  );
}

async function admin(request: Request, locals: unknown) {
  const env = runtimeEnv(locals);
  const user = await getSessionUser(request, env);
  return { env, user };
}

export const GET: APIRoute = async ({ request, locals }) => {
  const { env, user } = await admin(request, locals);
  if (!user)
    return Response.json(
      { error: "Sign in required." },
      { status: 401, headers },
    );
  if (!user.isAdmin)
    return Response.json(
      { error: "A national administrator must manage database migrations." },
      { status: 403, headers },
    );
  const db = await getDatabase(env);
  return Response.json(
    { migrations: await getMigrationStatus(db) },
    { headers },
  );
};

export const POST: APIRoute = async ({ request, locals }) => {
  const { env, user } = await admin(request, locals);
  if (!user)
    return Response.json(
      { error: "Sign in required." },
      { status: 401, headers },
    );
  if (!user.isAdmin)
    return Response.json(
      { error: "A national administrator must manage database migrations." },
      { status: 403, headers },
    );

  try {
    const body = (await request.json()) as Record<string, unknown>;
    const db = await getDatabase(env);
    const action = String(body.action ?? "");

    if (action === "preview") {
      return Response.json(
        {
          migrations: await getMigrationStatus(db),
          preview: await previewStandardBranches(db),
        },
        { headers },
      );
    }

    if (action === "apply") {
      const result = await runMigration(db, body.migrationId, user.memberId);
      return Response.json(
        {
          result,
          migrations: await getMigrationStatus(db),
          message: "Migration completed. The result is recorded below.",
        },
        { headers },
      );
    }

    if (action === "apply-all") {
      const results = await runAllMigrations(db, user.memberId);
      return Response.json(
        {
          results,
          migrations: await getMigrationStatus(db),
          message: "The ordered migrations completed. Their results are recorded below.",
        },
        { headers },
      );
    }

    return Response.json(
      { error: "Choose a migration action." },
      { status: 400, headers },
    );
  } catch (error) {
    return errorResponse(error);
  }
};
