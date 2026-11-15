import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Db } from "mongodb";
import { createMemoryDb } from "./db.ts";
import {
  JOB_RUNS_COLLECTION,
  jobErrorMessage,
  latestJobRun,
  withJobRun,
} from "./job-runs.ts";

const NOW = new Date("2026-11-15T00:00:00.000Z");

/** A database whose ledger collection refuses every write. */
function databaseWithFailingLedger(db: Db): Db {
  const failing = {
    insertOne: async () => {
      throw new Error("ledger unavailable");
    },
    find: () => {
      throw new Error("ledger unavailable");
    },
  };
  return new Proxy(db, {
    get(target, property) {
      if (property === "collection") {
        return (name: string) =>
          name === JOB_RUNS_COLLECTION
            ? failing
            : target.collection(name);
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function captureErrors<T>(run: () => Promise<T>): Promise<{
  result: T;
  logged: string[];
}> {
  const original = console.error;
  const logged: string[] = [];
  console.error = (...args: unknown[]) => {
    logged.push(args.map((value) => String(value)).join(" "));
  };
  try {
    return { result: await run(), logged };
  } finally {
    console.error = original;
  }
}

describe("durable job-run ledger", () => {
  it("records one entry per run with mode, counts and no identifiers", async () => {
    const db = createMemoryDb();
    const result = await withJobRun(
      db,
      "governance-scheduler",
      async () => ({ advanced: 2, closed: 1, errors: 0 }),
      {
        now: NOW,
        mode: "apply",
        summarise: (report) => ({
          advanced: report.advanced,
          closed: report.closed,
          errors: report.errors,
        }),
      },
    );

    assert.deepEqual(result, { advanced: 2, closed: 1, errors: 0 });
    const rows = await db.collection(JOB_RUNS_COLLECTION).find({}).toArray();
    assert.equal(rows.length, 1);
    const [entry] = rows;
    assert.equal(entry.job, "governance-scheduler");
    assert.equal(entry.ok, true);
    assert.equal(entry.mode, "apply");
    assert.deepEqual(entry.startedAt, NOW);
    assert.ok(entry.finishedAt instanceof Date);
    assert.deepEqual(entry.summary, { advanced: 2, closed: 1, errors: 0 });
    assert.equal(entry.error, undefined);
  });

  it("returns the newest run and can filter by mode", async () => {
    const db = createMemoryDb();
    await withJobRun(db, "ballot-digest", async () => "dry", {
      now: new Date(NOW.getTime() - 3_600_000),
      mode: "dry-run",
      summarise: () => ({ sent: 0 }),
    });
    await withJobRun(db, "ballot-digest", async () => "apply", {
      now: NOW,
      mode: "apply",
      summarise: () => ({ sent: 4 }),
    });

    assert.equal((await latestJobRun(db, { job: "ballot-digest" }))?.mode, "apply");
    assert.equal(
      (await latestJobRun(db, { job: "ballot-digest", mode: "dry-run" }))?.mode,
      "dry-run",
    );
    assert.equal(await latestJobRun(db, { job: "membership-verification" }), null);
  });

  it("records a failure and still surfaces the job's own error", async () => {
    const db = createMemoryDb();
    await assert.rejects(
      withJobRun(
        db,
        "membership-verification",
        async () => {
          throw new Error("CRM rejected the request");
        },
        { mode: "apply" },
      ),
      /CRM rejected the request/,
    );

    const entry = await latestJobRun(db, { job: "membership-verification" });
    assert.equal(entry?.ok, false);
    assert.equal(entry?.error, "CRM rejected the request");
  });

  it("a broken summary never fails the job", async () => {
    const db = createMemoryDb();
    const { result, logged } = await captureErrors(() =>
      withJobRun(db, "ballot-digest", async () => "sent", {
        mode: "apply",
        summarise: () => {
          throw new Error("summary exploded");
        },
      }),
    );

    assert.equal(result, "sent");
    assert.equal(logged.length, 1);
    assert.match(logged[0] ?? "", /job_run_summary_failed/);
    const entry = await latestJobRun(db, { job: "ballot-digest" });
    assert.equal(entry?.ok, true);
    assert.equal(entry?.summary, undefined);
  });

  it("a ledger failure never turns a successful job into a failure", async () => {    const db = databaseWithFailingLedger(createMemoryDb());
    const { result, logged } = await captureErrors(() =>
      withJobRun(db, "ballot-digest", async () => ({ sent: 3, held: 0 }), {
        mode: "apply",
      }),
    );

    assert.deepEqual(result, { sent: 3, held: 0 });
    assert.equal(logged.length, 1);
    assert.match(logged[0] ?? "", /job_run_ledger_write_failed/);
  });

  it("a ledger failure does not hide the job's own failure", async () => {
    const db = databaseWithFailingLedger(createMemoryDb());
    const { logged } = await captureErrors(async () => {
      await assert.rejects(
        withJobRun(db, "ballot-digest", async () => {
          throw new Error("digest failed");
        }),
        /digest failed/,
      );
    });
    assert.equal(logged.length, 1);
    assert.match(logged[0] ?? "", /ledger unavailable/);
  });

  it("keeps tokens and long opaque values out of recorded errors", async () => {
    const db = createMemoryDb();
    // Synthetic value shaped like a provider key; it is not a real credential.
    const secret = "provider-key-synthetic-9d8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b";
    await assert.rejects(
      withJobRun(db, "ballot-digest", async () => {
        throw new Error(`provider said: Bearer ${secret}`);
      }),
    );

    const entry = await latestJobRun(db, { job: "ballot-digest" });
    assert.ok(entry);
    assert.ok(!JSON.stringify(entry).includes(secret));
    assert.match(entry.error ?? "", /\[redacted\]/);
    assert.equal(jobErrorMessage(secret).includes(secret), false);
  });
});
