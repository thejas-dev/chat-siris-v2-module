/**
 * One-shot migration: legacy `users` → `chat_auth.identities` + `chat_users.profiles`.
 * Read-only on legacy collection; idempotent (skips existing _id).
 */
import mongoose, { Schema, type Connection, type Types } from "mongoose";

type LegacyUser = {
  _id: Types.ObjectId;
  username: string;
  email: string;
  isAvatarImageSet: boolean;
  avatarImage: string;
  admin: string;
  inChannel: string;
  backgroundImage: string;
  createdAt?: Date;
  updatedAt?: Date;
};

type MigrationStats = {
  total: number;
  migrated: number;
  skipped: number;
  failed: number;
};

const legacyUserSchema = new Schema(
  {},
  { strict: false, collection: "users" },
);

async function connectLegacy(uri: string): Promise<Connection> {
  return mongoose.createConnection(uri).asPromise();
}

async function connectTarget(uri: string, dbName: string): Promise<Connection> {
  return mongoose
    .createConnection(uri, { dbName, autoIndex: false })
    .asPromise();
}

async function migrateUser(
  user: LegacyUser,
  authConn: Connection,
  usersConn: Connection,
): Promise<"migrated" | "skipped" | "failed"> {
  const identities = authConn.collection("identities");
  const profiles = usersConn.collection("profiles");

  const existingIdentity = await identities.findOne({ _id: user._id });
  const existingProfile = await profiles.findOne({ _id: user._id });

  if (existingIdentity && existingProfile) {
    return "skipped";
  }

  if (existingIdentity || existingProfile) {
    console.error(
      `[FAIL] Partial split for _id=${user._id.toString()} — identity=${!!existingIdentity} profile=${!!existingProfile}`,
    );
    return "failed";
  }

  const timestamps = {
    createdAt: user.createdAt ?? new Date(),
    updatedAt: user.updatedAt ?? new Date(),
  };

  try {
    await identities.insertOne({
      _id: user._id,
      email: user.email,
      ...timestamps,
    });

    await profiles.insertOne({
      _id: user._id,
      username: user.username,
      avatarImage: user.avatarImage ?? "",
      isAvatarImageSet: user.isAvatarImageSet ?? false,
      backgroundImage: user.backgroundImage ?? "",
      admin: user.admin ?? "",
      inChannel: user.inChannel ?? "",
      ...timestamps,
    });

    return "migrated";
  } catch (err) {
    console.error(`[FAIL] _id=${user._id.toString()}:`, err);
    await identities.deleteOne({ _id: user._id }).catch(() => undefined);
    await profiles.deleteOne({ _id: user._id }).catch(() => undefined);
    return "failed";
  }
}

async function ensureIndexes(
  authConn: Connection,
  usersConn: Connection,
): Promise<void> {
  await authConn.collection("identities").createIndex(
    { email: 1 },
    { unique: true },
  );
  await authConn.collection("identities").createIndex(
    { googleSub: 1 },
    { unique: true, sparse: true },
  );
  await usersConn.collection("profiles").createIndex(
    { username: 1 },
    { unique: true },
  );
}

export async function runMigration(): Promise<MigrationStats> {
  const legacyUri = process.env.LEGACY_MONGODB_URI;
  const targetUri = process.env.MONGODB_URI;
  const authDb = process.env.MONGODB_AUTH_DB_NAME ?? "chat_auth";
  const usersDb = process.env.MONGODB_USERS_DB_NAME ?? "chat_users";

  if (!legacyUri || !targetUri) {
    throw new Error("LEGACY_MONGODB_URI and MONGODB_URI are required");
  }

  const legacyConn = await connectLegacy(legacyUri);
  const authConn = await connectTarget(targetUri, authDb);
  const usersConn = await connectTarget(targetUri, usersDb);

  await ensureIndexes(authConn, usersConn);

  const LegacyUserModel = legacyConn.model("LegacyUser", legacyUserSchema);
  const users = (await LegacyUserModel.find({}).lean()) as LegacyUser[];

  const stats: MigrationStats = {
    total: users.length,
    migrated: 0,
    skipped: 0,
    failed: 0,
  };

  console.log(`Found ${stats.total} legacy users`);

  for (const user of users) {
    const result = await migrateUser(user, authConn, usersConn);
    stats[result === "migrated" ? "migrated" : result === "skipped" ? "skipped" : "failed"]++;
  }

  console.log("Migration complete:", stats);

  await legacyConn.close();
  await authConn.close();
  await usersConn.close();

  return stats;
}

async function main(): Promise<void> {
  const stats = await runMigration();

  const failureRate = stats.total > 0 ? stats.failed / stats.total : 0;
  if (failureRate > 0.001) {
    console.error(
      `Failure rate ${(failureRate * 100).toFixed(2)}% exceeds 0.1% threshold — abort`,
    );
    process.exit(1);
  }
}

const isDirectRun =
  typeof require !== "undefined" &&
  require.main === module;

if (isDirectRun) {
  main().catch((err: unknown) => {
    console.error("Migration failed:", err);
    process.exit(1);
  });
}
