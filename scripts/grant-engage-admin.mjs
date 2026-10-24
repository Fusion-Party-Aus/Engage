import { MongoClient, ObjectId } from 'mongodb';
const memberId = process.argv[2];
if (process.env.APP_MODE !== 'production' || !/^[a-f0-9]{24}$/.test(memberId ?? '') || !process.env.MONGODB_URI || !process.env.MONGODB_DB_NAME) throw new Error('Use production configuration and an existing Better Auth user ID: node scripts/grant-engage-admin.mjs <userId>');
const client = await MongoClient.connect(process.env.MONGODB_URI);
try {
  const db = client.db(process.env.MONGODB_DB_NAME);
  if (!await db.collection('user').findOne({ _id: new ObjectId(memberId) })) throw new Error('Account not found. Sign in first.');
  await db.collection('application_roles').createIndex({ memberId: 1, role: 1 }, { unique: true, name: "member_role_unique" });
  await db.collection('operational_audit').insertOne({ actorId: 'deployment-operator', action: 'administrator_grant_requested', targetId: memberId, createdAt: new Date() });
  await db.collection('application_roles').updateOne({ memberId, role: 'administrator' }, { $set: { grantedAt: new Date() } }, { upsert: true });
  console.log('Administrator role granted to existing Engage account.');
} finally { await client.close(); }
