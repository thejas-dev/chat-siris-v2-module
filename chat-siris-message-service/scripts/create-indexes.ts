import mongoose from "mongoose";
import { MessageModel } from "../src/models/message.model";

require("dotenv").config();

async function main(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error("MONGODB_URI is required");
  }

  const dbName = process.env.MONGODB_DB_NAME ?? "chat_messages";
  await mongoose.connect(uri, { dbName });

  await MessageModel.syncIndexes();
  const indexes = await MessageModel.collection.indexes();

  console.log(
    JSON.stringify(
      {
        dbName,
        collection: "messages",
        indexes,
      },
      null,
      2,
    ),
  );

  await mongoose.disconnect();
}

main().catch((err: unknown) => {
  console.error("create-indexes failed:", err);
  process.exit(1);
});
