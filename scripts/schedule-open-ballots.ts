import { MongoClient } from "mongodb";
import { CURRENT_BALLOT_CLOSES_AT, ballotExpired } from "../src/lib/ballot-deadline.ts";
// Direct connection only: never silently modify the development fallback database.
if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is required");
const client = await new MongoClient(process.env.MONGODB_URI).connect();
try {
  const db = client.db(process.env.MONGODB_DB_NAME || "engage");
  const proposals = (await db.collection("proposals").find({stage: "decide"}).toArray()).filter(p => !ballotExpired({ballotClosesAt:p.ballotClosesAt}));
  const amendments = (await db.collection("amendments").find({status: "voting"}).toArray()).filter(p => !ballotExpired({ballotClosesAt:p.ballotClosesAt}));
  const closesAt = new Date(CURRENT_BALLOT_CLOSES_AT);
  if (closesAt <= new Date()) throw new Error("This one-time deadline is in the past.");
  console.log(JSON.stringify({mode: process.argv.includes("--apply") ? "apply" : "preview", closesAt, proposals: proposals.map(p=>({id:p.proposalId, previous:p.ballotClosesAt ?? null})), amendments: amendments.map(p=>({id:p.amendmentId, previous:p.ballotClosesAt ?? null}))}, null, 2));
  if (process.argv.includes("--apply")) {
    // Transactions keep the schedule and its before/after audit together; a concurrent closure fails the transaction.
    const session = client.startSession();
    try { await session.withTransaction(async () => {
      for (const [collection, items, field, state] of [["proposals", proposals, "stage", "decide"], ["amendments", amendments, "status", "voting"]] as const) {
        for (const item of items) {
          const result = await db.collection(collection).updateOne({_id:item._id, [field]:state, ballotClosesAt: item.ballotClosesAt ?? {$exists:false}}, {$set:{ballotClosesAt:closesAt}}, {session});
          if (result.matchedCount !== 1) throw new Error("Ballot changed during scheduling; preview again.");
        }
      }
      await db.collection("ballot_schedule_events").insertOne({event:"schedule-open-ballots-2026-11-09", at:new Date(), closesAt, proposals:proposals.map(p=>({id:p.proposalId, previous:p.ballotClosesAt ?? null})), amendments:amendments.map(p=>({id:p.amendmentId, previous:p.ballotClosesAt ?? null}))}, {session});
    }); } finally { await session.endSession(); }
    console.log("Schedule applied and audited.");
  }
} finally { await client.close(); }
