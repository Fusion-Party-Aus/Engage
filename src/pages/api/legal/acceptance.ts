import type { APIRoute } from "astro";
import { getSessionUser } from "../../../lib/auth.ts";
import { getDatabase, runtimeEnv } from "../../../lib/db.ts";
import {
  buildLegalAcceptanceManifest,
  legalAcceptanceStatus,
  LegalAcceptanceError,
  recordLegalAcceptance,
  type LegalAcceptanceEnv,
} from "../../../lib/legal-acceptance.ts";

export const prerender = false;

const headers = { "cache-control": "private, no-store" };

export const GET: APIRoute = async ({ request, locals }) => {
  const env = runtimeEnv(locals) as LegalAcceptanceEnv;
  const user = await getSessionUser(request, env);
  if (!user) {
    return Response.json({ error: "Sign in required." }, { status: 401, headers });
  }

  const db = await getDatabase(env);
  const manifest = buildLegalAcceptanceManifest(env);
  const status = await legalAcceptanceStatus(db, user.memberId, manifest);
  return Response.json(status, { headers });
};

export const POST: APIRoute = async ({ request, locals }) => {
  const env = runtimeEnv(locals) as LegalAcceptanceEnv;
  const user = await getSessionUser(request, env);
  if (!user) {
    return Response.json({ error: "Sign in required." }, { status: 401, headers });
  }

  const db = await getDatabase(env);
  const manifest = buildLegalAcceptanceManifest(env);
  if (!manifest.enabled) {
    return Response.json(
      {
        error:
          "Legal acceptance is not active until the current documents are published with an effective date.",
        code: "LEGAL_ACCEPTANCE_NOT_ACTIVE",
      },
      { status: 409, headers },
    );
  }

  try {
    const body = (await request.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const termsVersion = String(body.termsVersion ?? "");
    const privacyVersion = String(body.privacyVersion ?? "");

    if (
      termsVersion !== manifest.termsVersion ||
      privacyVersion !== manifest.privacyVersion
    ) {
      return Response.json(
        {
          error:
            "The legal documents have changed since this page was loaded. Reload and review the current versions.",
          code: "LEGAL_DOCUMENTS_CHANGED",
        },
        { status: 409, headers },
      );
    }

    const record = await recordLegalAcceptance(db, {
      memberId: user.memberId,
      termsAccepted: body.termsAccepted === true,
      privacyAcknowledged: body.privacyAcknowledged === true,
      manifest,
    });

    return Response.json(
      {
        accepted: true,
        termsVersion: record.termsVersion,
        privacyVersion: record.privacyVersion,
        acceptedAt: record.acceptedAt,
      },
      { status: 201, headers },
    );
  } catch (error) {
    if (error instanceof LegalAcceptanceError) {
      return Response.json(
        { error: error.message, code: error.code },
        { status: error.status, headers },
      );
    }
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Could not record legal acceptance.",
      },
      { status: 400, headers },
    );
  }
};
