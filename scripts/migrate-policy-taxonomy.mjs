#!/usr/bin/env node
import { MongoClient } from 'mongodb';
import { taxonomyMigrationPatch } from '../src/lib/platform/taxonomy.ts';

const apply = process.argv.includes('--apply');
if (!process.env.MONGODB_URI || !process.env.MONGODB_DB_NAME) throw new Error('Set MONGODB_URI and MONGODB_DB_NAME for the intended database. Defaults to dry-run; --apply writes taxonomy metadata only.');
const client = await new MongoClient(process.env.MONGODB_URI).connect();
try {
  const revisions = client.db(process.env.MONGODB_DB_NAME).collection('policy_revisions');
  let examined = 0, changed = 0;
  for await (const revision of revisions.find({})) {
    examined++;
    const patch = taxonomyMigrationPatch(revision);
    if (!Object.keys(patch).length) continue;
    console.log(JSON.stringify({ policyId: revision.policyId, revisionId: revision.revisionId, taxonomy: patch }));
    if (apply) {
      const result = await revisions.updateOne({ _id: revision._id, taxonomyVersion: { $ne: 1 }, domain: revision.domain ?? null }, { $set: patch });
      changed += result.modifiedCount;
    } else changed++;
  }
  console.log(JSON.stringify({ database: process.env.MONGODB_DB_NAME, mode: apply ? 'applied' : 'dry-run', examined, changed }));
} finally { await client.close(); }
