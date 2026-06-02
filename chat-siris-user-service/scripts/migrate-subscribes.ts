import mongoose from "mongoose";
import { MongoClient } from "mongodb";
import { SubscribeModel } from "../src/models/subscribe.model";

require("dotenv").config();

type LegacySubscribe = {
  _id: unknown;
  gmail: string;
  createdAt?: Date;
  updatedAt?: Date;
};

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
  const legacySubscribes = legacyClient
    .db()
    .collection<LegacySubscribe>("subscribes");

  const targetDbName = process.env.MONGODB_DB_NAME ?? "chat_users";
  await mongoose.connect(targetUri, { dbName: targetDbName });

  const legacyCount = await legacySubscribes.countDocuments();
  let migrated = 0;
  let skipped = 0;

  const cursor = legacySubscribes.find({});
  for await (const doc of cursor) {
    const existing = await SubscribeModel.findById(
      doc._id as mongoose.Types.ObjectId,
    );
    if (existing) {
      skipped++;
      continue;
    }

    await SubscribeModel.create({
      _id: doc._id,
      gmail: doc.gmail,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    });
    migrated++;
  }

  const targetCount = await SubscribeModel.countDocuments();
  console.log(
    JSON.stringify({
      legacyCount,
      migrated,
      skipped,
      targetCount,
      ok: targetCount >= legacyCount - skipped,
    }),
  );

  await legacyClient.close();
  await mongoose.disconnect();

  if (targetCount < legacyCount - skipped) {
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error("migrate-subscribes failed:", err);
  process.exit(1);
});
