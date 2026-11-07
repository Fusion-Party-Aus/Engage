const databaseName =
  process.env.MONGO_INITDB_DATABASE || "fusion_horizon_policy_preview";
const appDatabase = db.getSiblingDB(databaseName);

appDatabase.createUser({
  user: process.env.MONGO_APP_USER,
  pwd: process.env.MONGO_APP_PASSWORD,
  roles: [{ role: "readWrite", db: databaseName }],
});
