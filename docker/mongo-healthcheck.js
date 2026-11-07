// The official entrypoint first starts a temporary standalone server to create
// users. Only initialise replication after the final --replSet server starts.
const admin = db.getSiblingDB("admin");
if (
  !admin.auth(
    process.env.MONGO_INITDB_ROOT_USERNAME,
    process.env.MONGO_INITDB_ROOT_PASSWORD,
  )
)
  quit(1);
let hello = admin.runCommand({ hello: 1 });
if (!hello.setName) {
  const result = admin.runCommand({
    replSetInitiate: {
      _id: "engage",
      members: [{ _id: 0, host: "mongo:27017" }],
    },
  });
  if (!result.ok) quit(1);
  hello = admin.runCommand({ hello: 1 });
}
quit(hello.setName === "engage" && hello.isWritablePrimary ? 0 : 1);
