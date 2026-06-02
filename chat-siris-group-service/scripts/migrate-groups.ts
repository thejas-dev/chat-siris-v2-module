import mongoose from "mongoose";
import { MongoClient, ObjectId } from "mongodb";
import { GroupModel } from "../src/models/group.model";

require("dotenv").config();

type LegacyUserSnapshot = {
  _id?: string;
  username?: string;
  avatarImage?: string;
  isAvatarImageSet?: boolean;
};

type LegacyGroup = {
  _id: unknown;
  name: string;
  admin?: string;
  adminId?: string;
  description?: string;
  password?: string;
  privacy?: boolean;
  users?: LegacyUserSnapshot[];
  adminOnly?: boolean;
  createdAt?: Date;
  updatedAt?: Date;
};

type LegacyUser = {
  _id: ObjectId;
  username?: string;
};

async function resolveAdminId(
  doc: LegacyGroup,
  legacyUsers: ReturnType<ReturnType<MongoClient["db"]>["collection"]>,
): Promise<string | null> {
  if (doc.adminId) {
    return doc.adminId;
  }

  const users = doc.users ?? [];
  if (doc.admin) {
    const byUsername = users.find((user) => user.username === doc.admin);
    if (byUsername?._id) {
      return byUsername._id;
    }

    const legacyUser = (await legacyUsers.findOne({
      username: doc.admin,
    })) as LegacyUser | null;
    if (legacyUser?._id) {
      return legacyUser._id.toString();
    }
  }

  const firstWithId = users.find((user) => user._id);
  return firstWithId?._id ?? null;
}

async function main(): Promise<void> {
  const legacyUri = process.env.LEGACY_MONGODB_URI ?? process.env.MONGODB_URI;
  if (!legacyUri) {
    throw new Error("LEGACY_MONGODB_URI or MONGODB_URI is required");
  }

  const targetUri = process.env.MONGODB_URI;
  if (!targetUri) {
    throw new Error("MONGODB_URI is required");
  }

  const legacyClient = new MongoClient(legacyUri);
  await legacyClient.connect();
  const legacyDb = legacyClient.db();
  const legacyGroups = legacyDb.collection<LegacyGroup>("groups");
  const legacyUsers = legacyDb.collection<LegacyUser>("users");

  const targetDbName = process.env.MONGODB_DB_NAME ?? "chat_groups";
  await mongoose.connect(targetUri, { dbName: targetDbName });

  const legacyCount = await legacyGroups.countDocuments();
  let migrated = 0;
  let skipped = 0;
  let failed = 0;
  const failures: Array<{ id: string; name?: string; reason: string }> = [];

  const cursor = legacyGroups.find({});
  for await (const doc of cursor) {
    const id = String(doc._id);

    const existing = await GroupModel.findById(doc._id as mongoose.Types.ObjectId);
    if (existing) {
      skipped++;
      continue;
    }

    const resolvedAdminId = await resolveAdminId(doc, legacyUsers);
    const adminId = resolvedAdminId ?? "legacy-unresolved";

    if (!doc.name || doc.name.length < 3) {
      failed++;
      failures.push({ id, name: doc.name, reason: "invalid or missing name" });
      continue;
    }

    try {
      await GroupModel.create({
        _id: doc._id,
        name: doc.name,
        admin: doc.admin ?? "",
        adminId,
        description: doc.description,
        password: doc.password,
        privacy: doc.privacy ?? false,
        users: (doc.users ?? []).map((user) => ({
          _id: user._id ?? "",
          username: user.username ?? "",
          avatarImage: user.avatarImage ?? "",
          isAvatarImageSet: user.isAvatarImageSet ?? false,
        })),
        adminOnly: doc.adminOnly ?? false,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
      });
      migrated++;
    } catch (err) {
      failed++;
      failures.push({
        id,
        name: doc.name,
        reason: err instanceof Error ? err.message : "unknown error",
      });
    }
  }

  const targetCount = await GroupModel.countDocuments();
  const failureRate = legacyCount > 0 ? failed / legacyCount : 0;

  console.log(
    JSON.stringify(
      {
        legacyCount,
        migrated,
        skipped,
        failed,
        targetCount,
        failureRate,
        ok: failureRate <= 0.001 && targetCount >= legacyCount - skipped - failed,
        failures: failures.slice(0, 20),
      },
      null,
      2,
    ),
  );

  await legacyClient.close();
  await mongoose.disconnect();

  if (failureRate > 0.001) {
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error("migrate-groups failed:", err);
  process.exit(1);
});
