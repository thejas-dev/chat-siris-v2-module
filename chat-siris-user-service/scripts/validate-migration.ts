/**
 * Post-migration validation: count parity, _id parity, field parity.
 * Exits 1 if failure rate > 0.1%.
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
};

type IdentityDoc = {
  _id: Types.ObjectId;
  email: string;
};

type ProfileDoc = {
  _id: Types.ObjectId;
  username: string;
  avatarImage: string;
  isAvatarImageSet: boolean;
  backgroundImage: string;
  admin: string;
  inChannel: string;
};

const legacyUserSchema = new Schema(
  {},
  { strict: false, collection: "users" },
);

async function connectLegacy(uri: string): Promise<Connection> {
  return mongoose.createConnection(uri).asPromise();
}

async function connectTarget(uri: string, dbName: string): Promise<Connection> {
  return mongoose.createConnection(uri, { dbName }).asPromise();
}

function fieldsMatch(legacy: LegacyUser, profile: ProfileDoc): boolean {
  return (
    profile.username === legacy.username &&
    profile.avatarImage === (legacy.avatarImage ?? "") &&
    profile.isAvatarImageSet === (legacy.isAvatarImageSet ?? false) &&
    profile.backgroundImage === (legacy.backgroundImage ?? "") &&
    profile.admin === (legacy.admin ?? "") &&
    profile.inChannel === (legacy.inChannel ?? "")
  );
}

export async function runValidation(): Promise<number> {
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

  const LegacyUser = legacyConn.model("LegacyUser", legacyUserSchema);

  const [legacyUsers, identities, profiles] = await Promise.all([
    LegacyUser.find({}).lean() as Promise<LegacyUser[]>,
    authConn.collection("identities").find({}).toArray() as Promise<IdentityDoc[]>,
    usersConn.collection("profiles").find({}).toArray() as Promise<ProfileDoc[]>,
  ]);

  const legacyCount = legacyUsers.length;
  const identityCount = identities.length;
  const profileCount = profiles.length;

  console.log("Counts:", {
    legacy: legacyCount,
    identities: identityCount,
    profiles: profileCount,
  });

  let failures = 0;

  if (identityCount !== legacyCount || profileCount !== legacyCount) {
    console.error("P1-P-01 FAIL: count mismatch");
    failures +=
      Math.abs(legacyCount - identityCount) +
      Math.abs(legacyCount - profileCount);
  }

  const identityById = new Map(
    identities.map((doc) => [doc._id.toString(), doc]),
  );
  const profileById = new Map(
    profiles.map((doc) => [doc._id.toString(), doc]),
  );

  for (const legacy of legacyUsers) {
    const id = legacy._id.toString();
    const identity = identityById.get(id);
    const profile = profileById.get(id);

    if (!identity || !profile) {
      console.error(`P1-P-02 FAIL: missing split for _id=${id}`);
      failures++;
      continue;
    }

    if (identity.email !== legacy.email) {
      console.error(`P1-P-03 FAIL: email mismatch for _id=${id}`);
      failures++;
    }

    if (!fieldsMatch(legacy, profile)) {
      console.error(`P1-P-03 FAIL: profile field mismatch for _id=${id}`);
      failures++;
    }
  }

  const failureRate = legacyCount > 0 ? failures / legacyCount : 0;
  console.log(
    `Validation: ${failures} failures out of ${legacyCount} (${(failureRate * 100).toFixed(3)}%)`,
  );

  await legacyConn.close();
  await authConn.close();
  await usersConn.close();

  return failureRate;
}

async function main(): Promise<void> {
  const failureRate = await runValidation();

  if (failureRate > 0.001) {
    console.error("P1-P-04 FAIL: failure rate exceeds 0.1%");
    process.exit(1);
  }

  console.log("Validation passed");
}

const isDirectRun =
  typeof require !== "undefined" &&
  require.main === module;

if (isDirectRun) {
  main().catch((err: unknown) => {
    console.error("Validation failed:", err);
    process.exit(1);
  });
}
