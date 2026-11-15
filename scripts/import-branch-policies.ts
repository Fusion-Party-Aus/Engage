import { readFile } from "node:fs/promises";
import { MongoClient } from "mongodb";
import {
  applyBranchPolicyImport,
  BranchPolicySourceError,
  formatBranchPolicyImportReport,
  planBranchPolicyImport,
  type BranchPolicySource,
} from "../src/lib/policy-import.ts";

/**
 * Import an external branch policy registry into Engage.
 *
 * Usage:
 *   pnpm policies:import-branch --source <url|file> --branch branch-vic [--dry-run]
 *                               [--report <path>] [--authority-basis <text>]
 *
 * Only records the source marks as adopted policy are imported. Nothing is
 * overwritten: a changed source becomes a conflict for review.
 */

const DEFAULT_SOURCE = "https://vic.fusionparty.org.au/api/policies.json";
const DEFAULT_AUTHORITY_BASIS =
  "Adopted by the Victorian branch executive. Confirmed by the Engage maintainer on 2026-11-15 that all live Victorian branch policies are ratified and adopted.";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : "";
}

const sourceArg = arg("source") ?? DEFAULT_SOURCE;
const branchId = arg("branch") ?? "branch-vic";
const dryRun = process.argv.includes("--dry-run");
const reportPath = arg("report");
const authorityBasis = arg("authority-basis") || DEFAULT_AUTHORITY_BASIS;

async function readSource(location: string): Promise<BranchPolicySource> {
  if (/^https?:\/\//.test(location)) {
    const response = await fetch(location, {
      headers: { accept: "application/json" },
    });
    if (!response.ok)
      throw new Error(
        `The policy source returned ${response.status} ${response.statusText}.`,
      );
    return (await response.json()) as BranchPolicySource;
  }
  return JSON.parse(await readFile(location, "utf8")) as BranchPolicySource;
}

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB_NAME;
if (!uri || !dbName)
  throw new Error("MONGODB_URI and MONGODB_DB_NAME are required.");

const source = await readSource(sourceArg);
const client = new MongoClient(uri);
await client.connect();
try {
  const db = client.db(dbName);
  const branch = await db
    .collection("branches")
    .findOne({ branchId, recognised: true });
  if (!branch)
    throw new Error(
      `The recognised branch '${branchId}' was not found. Run \`pnpm branches:migrate\` first.`,
    );
  const plan = await planBranchPolicyImport(db, {
    source,
    sourceUrl: sourceArg,
    branch: {
      branchId,
      name: String(branch.name ?? branchId),
      code: branchId.replace(/^branch-/, ""),
    },
    authorityBasis,
    importedAt: new Date(),
    importedBy: "system:branch-policy-import",
  });
  const result = dryRun ? plan : await applyBranchPolicyImport(db, plan);
  console.log(
    formatBranchPolicyImportReport(result, { dryRun }),
  );
  if (reportPath) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      reportPath,
      JSON.stringify(
        {
          runId: result.runId,
          sourceUrl: result.sourceUrl,
          branchId: result.branchId,
          authorityBasis: result.authorityBasis,
          importedAt: result.importedAt,
          dryRun,
          counts: result.counts,
          entries: result.entries.map((entry) => ({
            policyId: entry.policyId,
            title: entry.title,
            action: entry.action,
            reason: entry.reason,
            contentHash: entry.contentHash,
          })),
          missing: result.missing,
          errors: result.errors,
        },
        null,
        2,
      ),
    );
    console.log(`\nReport written to ${reportPath}`);
  }
  if (result.counts.conflict || result.counts.changed)
    process.exitCode = 2;
} catch (error) {
  if (error instanceof BranchPolicySourceError) {
    console.error("The source document cannot be imported:");
    for (const issue of error.issues) console.error(`- ${issue}`);
    process.exitCode = 1;
  } else {
    throw error;
  }
} finally {
  await client.close();
}
