import mongoose, { Types } from "mongoose";
import type { MergedUser } from "./user-client.service";

let legacyConn: mongoose.Connection | null = null;

function legacyUri(): string | undefined {
  return process.env.LEGACY_MONGODB_URI ?? process.env.MONGODB_URI;
}

async function getLegacyConnection(): Promise<mongoose.Connection | null> {
  const uri = legacyUri();
  if (!uri) {
    return null;
  }

  if (!legacyConn) {
    // Monolith uses the cluster default DB (no dbName) for the `users` collection.
    legacyConn = await mongoose.createConnection(uri).asPromise();
  }

  return legacyConn;
}

export async function syncLegacyUser(user: MergedUser): Promise<void> {
  const conn = await getLegacyConnection();
  if (!conn) {
    return;
  }

  const users = conn.collection("users");
  const _id = new Types.ObjectId(user._id);
  const now = new Date();

  await users.updateOne(
    { _id },
    {
      $set: {
        username: user.username,
        email: user.email,
        avatarImage: user.avatarImage ?? "",
        isAvatarImageSet: user.isAvatarImageSet ?? false,
        backgroundImage: user.backgroundImage ?? "",
        admin: user.admin ?? "",
        inChannel: user.inChannel ?? "",
        updatedAt: now,
      },
      $setOnInsert: {
        createdAt: now,
      },
    },
    { upsert: true },
  );
}
