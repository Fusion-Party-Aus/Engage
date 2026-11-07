/**
 * Reviewable, idempotent migration for legacy Decide-stage ballots.
 *
 * Usage:
 *   node --experimental-strip-types scripts/ballot-migration.ts inventory \
 *     --database engage_production_clone --out-json inventory.json --out-md inventory.md
 *
 *   node --experimental-strip-types scripts/ballot-migration.ts plan \
 *     --database engage_production_clone --inventory inventory.json
 *
 *   node --experimental-strip-types scripts/ballot-migration.ts apply \
 *     --database engage_production_clone --inventory inventory.json --apply
 *
 * The apply command is dry-run unless --apply is present. Production requires
 * both --allow-production and --confirm-production engage_production.
 */
import { MongoClient } from "mongodb";
import { readFile, writeFile } from "node:fs/promises";
import {
  applyBulkBinding,
  buildBallotInventory,
  buildBulkBindingPlan,
  renderInventoryMarkdown,
  verifyBallotInventory,
  type BallotInventory,
  type BulkBindingOptions,
} from "../src/lib/ballot-migration.ts";

const args = process.argv.slice(2);
const command =
  args[0] && !args[0].startsWith("--") ? args[0] : "inventory";
const value = (name: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const has = (name: string) => args.includes(`--${name}`);

const uri = value("uri") ?? process.env.MONGODB_URI;
const database = value("database");
if (!uri)
  throw new Error(
    "MongoDB URI is required via --uri or MONGODB_URI. Never point this at production by accident.",
  );
if (!database)
  throw new Error(
    "An explicit --database is required. Refusing to infer a database from the URI.",
  );

const production = database === "engage_production";
const productionWrite = production && command === "apply" && has("apply");
if (
  productionWrite &&
  (!has("allow-production") ||
    value("confirm-production") !== "engage_production")
) {
  throw new Error(
    "Binding production requires --allow-production and --confirm-production engage_production. This release candidate was not run against production.",
  );
}
if (production && !has("apply") && command === "apply")
  console.log(
    "[ballot-migration] production dry run: no writes will occur without --apply.",
  );

const batchId =
  value("batch-id") ?? "engage-legacy-ballots-2026-11-08";
const decisionEventId =
  value("decision-event-id") ??
  "retrospective-legacy-ballot-binding-2026-11-08";
const actorId = value("actor") ?? "system:retrospective-ballot-migration";
const reason =
  value("reason") ??
  "Authorised retrospective binding: proposal wording and content hash were confirmed unchanged since voting began; all existing votes are attached to this immutable revision.";
if (productionWrite && (!value("actor") || actorId.startsWith("system:")))
  throw new Error(
    "Production apply requires an explicit --actor identifying the authorised operator.",
  );
const options: BulkBindingOptions = {
  batchId,
  decisionEventId,
  actorId,
  reason,
};

const outputJson = value("out-json");
const outputMarkdown = value("out-md");
const inputInventory = value("inventory");

const client = await new MongoClient(uri).connect();
const db = client.db(database);
try {
  console.log(
    `[ballot-migration] command=${command} database=${database} batch=${batchId}`,
  );

  const loadInventory = async (includeBound: boolean) => {
    if (!inputInventory) return buildBallotInventory(db, { includeBound });
    const parsed = JSON.parse(
      await readFile(inputInventory, "utf8"),
    ) as BallotInventory;
    if (parsed.version !== 1)
      throw new Error("Inventory file version must be 1.");
    return parsed;
  };

  if (command === "inventory") {
    const inventory = await loadInventory(has("include-bound"));
    const json = `${JSON.stringify(inventory, null, 2)}\n`;
    if (outputJson) await writeFile(outputJson, json);
    if (outputMarkdown)
      await writeFile(outputMarkdown, `${renderInventoryMarkdown(inventory)}\n`);
    console.log(
      `[ballot-migration] ballots=${inventory.ballotCount} votes=${inventory.totalVotes} classifications=${JSON.stringify(inventory.classifications)}`,
    );
    if (!outputJson) console.log(json);
  } else if (command === "plan") {
    const inventory = await loadInventory(true);
    const plan = buildBulkBindingPlan(inventory, options);
    if (outputJson) await writeFile(outputJson, `${JSON.stringify(plan, null, 2)}\n`);
    console.log(JSON.stringify(plan, null, 2));
    if (plan.blockers.length) process.exitCode = 2;
  } else if (command === "apply") {
    const inventory = await loadInventory(true);
    const plan = buildBulkBindingPlan(inventory, options);
    console.log(JSON.stringify(plan, null, 2));
    if (plan.blockers.length) {
      console.error(
        `[ballot-migration] refused: ${plan.blockers.length} blocker(s).`,
      );
      process.exitCode = 2;
    } else if (!has("apply")) {
      console.log(
        "[ballot-migration] dry run only. Re-run with --apply to commit this plan.",
      );
    } else {
      const result = await applyBulkBinding(db, inventory, options, {
        apply: true,
      });
      console.log(JSON.stringify(result, null, 2));
      if (result.verification.failures.length) process.exitCode = 3;
    }
  } else if (command === "verify") {
    const inventory = await loadInventory(true);
    const verification = await verifyBallotInventory(db, inventory);
    console.log(JSON.stringify(verification, null, 2));
    if (verification.failures.length) process.exitCode = 3;
  } else {
    throw new Error(
      `Unknown command '${command}'. Use inventory, plan, apply or verify.`,
    );
  }
} finally {
  await client.close();
}
