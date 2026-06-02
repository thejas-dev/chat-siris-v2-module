import mongoose from "mongoose";
import { MongoClient } from "mongodb";
import { MessageModel } from "../src/models/message.model";

require("dotenv").config();

type LegacyMessage = {
  _id: unknown;
  group?: string | string[];
  message?: { text?: string } | string;
  byUserName?: string;
  byUserImage?: string;
  createdAt?: Date;
  updatedAt?: Date;
};

function normalizeLegacyGroup(group: LegacyMessage["group"]): string | null {
  if (typeof group === "string" && group.length > 0) {
    return group;
  }
  if (Array.isArray(group) && group.length > 0) {
    return group.map(String).join("");
  }
  return null;
}

function normalizeLegacyText(message: LegacyMessage["message"]): string | null {
  if (typeof message === "string" && message.length > 0) {
    return message;
  }
  if (
    typeof message === "object" &&
    message !== null &&
    typeof message.text === "string" &&
    message.text.length > 0
  ) {
    return message.text;
  }
  return null;
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
  const legacyMessages = legacyDb.collection<LegacyMessage>("messages");

  const targetDbName = process.env.MONGODB_DB_NAME ?? "chat_messages";
  await mongoose.connect(targetUri, { dbName: targetDbName });
  await MessageModel.syncIndexes();

  const legacyCount = await legacyMessages.countDocuments();
  let migrated = 0;
  let skipped = 0;
  let failed = 0;
  const failures: Array<{ id: string; reason: string }> = [];

  const cursor = legacyMessages.find({});
  for await (const doc of cursor) {
    const id = String(doc._id);

    const existing = await MessageModel.findById(doc._id as mongoose.Types.ObjectId);
    if (existing) {
      skipped++;
      continue;
    }

    const group = normalizeLegacyGroup(doc.group);
    const text = normalizeLegacyText(doc.message);

    if (!group || !text || !doc.byUserName || !doc.byUserImage) {
      failed++;
      failures.push({ id, reason: "missing required fields" });
      continue;
    }

    try {
      await MessageModel.create({
        _id: doc._id,
        group,
        message: { text },
        byUserName: doc.byUserName,
        byUserImage: doc.byUserImage,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
      });
      migrated++;
    } catch (err) {
      failed++;
      failures.push({
        id,
        reason: err instanceof Error ? err.message : "unknown error",
      });
    }
  }

  const targetCount = await MessageModel.countDocuments();
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
  console.error("migrate-messages failed:", err);
  process.exit(1);
});
