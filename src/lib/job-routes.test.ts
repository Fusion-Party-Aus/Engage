import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { Db } from "mongodb";
import { getDatabase } from "./db.ts";
import { JOB_RUNS_COLLECTION, type JobRunRecord } from "./job-runs.ts";
import { POST as postDigest } from "../pages/api/email/digest.ts";
import { POST as postVerification } from "../pages/api/cron/membership-verification.ts";
import type { PlatformEnv } from "./types.ts";

/**
 * Route-level coverage for #39: an authorised scheduled run is recorded in the
 * job-run ledger, successful or not, and an unauthorised or disabled call is
 * not a run at all. Status codes and bodies must not change.
 */

const DIGEST_SECRET = "digest-secret-value-0123456789";
const VERIFICATION_SECRET = "verification-secret-value-0123456789";

const env: PlatformEnv & Record<string, string | undefined> = {
  APP_MODE: "test",
  MONGODB_URI: "",
  ENGAGE_CRON_SECRET: DIGEST_SECRET,
  ENGAGE_CRM_VERIFICATION_CRON_SECRET: VERIFICATION_SECRET,
};

async function database(): Promise<Db> {
  return getDatabase(env);
}

function digestRequest(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/email/digest", {
    method: "POST",
    headers,
  });
}

function verificationRequest(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/cron/membership-verification", {
    method: "POST",
    headers,
  });
}

async function ledger(db: Db): Promise<JobRunRecord[]> {
  return db.collection<JobRunRecord>(JOB_RUNS_COLLECTION).find({}).toArray();
}

beforeEach(async () => {
  await (await database()).collection(JOB_RUNS_COLLECTION).deleteMany({});
});

describe("scheduled digest route", () => {
  it("does not record an unauthorised call", async () => {
    const db = await database();
    const response = await postDigest({
      request: digestRequest(),
      locals: { runtime: { env } },
    } as never);

    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "Unauthorised" });
    assert.equal((await ledger(db)).length, 0);
  });

  it("does not record a call with the wrong secret", async () => {
    const db = await database();
    const response = await postDigest({
      request: digestRequest({ authorization: "Bearer wrong-secret" }),
      locals: { runtime: { env } },
    } as never);

    assert.equal(response.status, 401);
    assert.equal((await ledger(db)).length, 0);
  });

  it("records an authorised successful run and keeps the response body", async () => {
    const db = await database();
    const response = await postDigest({
      request: digestRequest({ authorization: `Bearer ${DIGEST_SECRET}` }),
      locals: { runtime: { env: { ...env, ENGAGE_DIGEST_ENABLED: "false" } } },
    } as never);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      disabled: true,
      sent: 0,
      held: 0,
    });

    const entries = await ledger(db);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.job, "ballot-digest");
    assert.equal(entries[0]?.mode, "apply");
    assert.equal(entries[0]?.ok, true);
    assert.deepEqual(entries[0]?.summary, {
      disabled: true,
      sent: 0,
      held: 0,
    });
  });

  it("records an authorised failure without exposing configuration", async () => {
    const db = await database();
    const response = await postDigest({
      request: digestRequest({ authorization: `Bearer ${DIGEST_SECRET}` }),
      locals: {
        runtime: {
          env: {
            ...env,
            ENGAGE_DIGEST_ENABLED: "true",
            ENGAGE_EMAIL_SECRET: "email-signing-secret-0123456789",
          },
        },
      },
    } as never);

    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: "Digest job failed; inspect delivery holds before retrying.",
    });

    const entries = await ledger(db);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.ok, false);
    assert.match(entries[0]?.error ?? "", /configuration is incomplete/);
    const serialised = JSON.stringify(entries);
    for (const secret of [
      DIGEST_SECRET,
      "email-signing-secret-0123456789",
    ]) {
      assert.equal(serialised.includes(secret), false, `leaked ${secret}`);
    }
  });
});

describe("scheduled membership verification route", () => {
  it("does not record an unauthorised call", async () => {
    const db = await database();
    const response = await postVerification({
      request: verificationRequest(),
      locals: { runtime: { env } },
    } as never);

    assert.equal(response.status, 401);
    assert.equal((await ledger(db)).length, 0);
  });

  it("does not record a disabled feature", async () => {
    const db = await database();
    const response = await postVerification({
      request: verificationRequest({
        authorization: `Bearer ${VERIFICATION_SECRET}`,
      }),
      locals: {
        runtime: {
          env: { ...env, ENGAGE_CRM_VERIFICATION_ENABLED: "false" },
        },
      },
    } as never);

    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: "Automatic CRM membership verification is not enabled.",
    });
    assert.equal((await ledger(db)).length, 0);
  });

  it("records an authorised failure and keeps the 503 contract", async () => {
    const db = await database();
    const response = await postVerification({
      request: verificationRequest({
        authorization: `Bearer ${VERIFICATION_SECRET}`,
      }),
      locals: {
        runtime: {
          env: {
            ...env,
            ENGAGE_CRM_VERIFICATION_ENABLED: "true",
            ENGAGE_CRM_TOKEN: "crm-token-value-0123456789abcdefghij",
          },
        },
      },
    } as never);

    assert.equal(response.status, 503);
    const body = (await response.json()) as { error: string };
    assert.match(body.error, /ENGAGE_CRM_BASE_URL/);

    const entries = await ledger(db);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.job, "membership-verification");
    assert.equal(entries[0]?.ok, false);
    assert.equal(
      JSON.stringify(entries).includes("crm-token-value-0123456789abcdefghij"),
      false,
    );
  });

  it("records an authorised successful run with counts only", async () => {
    const db = await database();
    const response = await postVerification({
      request: verificationRequest({
        authorization: `Bearer ${VERIFICATION_SECRET}`,
      }),
      locals: {
        runtime: {
          env: {
            ...env,
            ENGAGE_CRM_VERIFICATION_ENABLED: "true",
            ENGAGE_CRM_BASE_URL: "https://crm.example.test",
            ENGAGE_CRM_TOKEN: "crm-token-value-0123456789abcdefghij",
            ENGAGE_CRM_FUSION_MEMBERSHIP_TYPE_ID: "membership-type-1",
          },
        },
      },
    } as never);

    assert.equal(response.status, 200);
    const entries = await ledger(db);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.job, "membership-verification");
    assert.equal(entries[0]?.mode, "apply");
    assert.equal(entries[0]?.ok, true);
    assert.equal(typeof entries[0]?.summary?.processed, "number");
    assert.equal(JSON.stringify(entries).includes("crm-token"), false);
  });
});
