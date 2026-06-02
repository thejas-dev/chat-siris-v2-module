import mongoose, { Schema, type Document, type Types } from "mongoose";

export type MessageJson = {
  _id: string;
  group: string;
  message: { text: string };
  byUserName: string;
  byUserImage: string;
  createdAt: string;
  updatedAt: string;
};

export type MessageDocument = Document & {
  group: string;
  message: { text: string };
  byUserName: string;
  byUserImage: string;
  createdAt: Date;
  updatedAt: Date;
};

const messageSchema = new Schema<MessageDocument>(
  {
    group: { type: String, required: true, index: true },
    message: {
      text: { type: String, required: true },
    },
    byUserName: { type: String, required: true },
    byUserImage: { type: String, required: true },
  },
  { timestamps: true, collection: "messages" },
);

messageSchema.index({ group: 1, createdAt: -1, _id: -1 });

export const MessageModel = mongoose.model<MessageDocument>(
  "Message",
  messageSchema,
);

export function toMessageJson(doc: MessageDocument): MessageJson {
  return {
    _id: doc._id.toString(),
    group: doc.group,
    message: { text: doc.message.text },
    byUserName: doc.byUserName,
    byUserImage: doc.byUserImage,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

export function normalizeGroupName(group: unknown): string | null {
  if (typeof group === "string" && group.length > 0) {
    return group;
  }
  if (Array.isArray(group) && group.length > 0) {
    return group.map(String).join("");
  }
  return null;
}

export function cursorFromMessage(doc: MessageDocument): {
  createdAt: string;
  _id: string;
} {
  return {
    createdAt: doc.createdAt.toISOString(),
    _id: doc._id.toString(),
  };
}

export function buildOlderThanQuery(
  channelName: string,
  cursor?: { createdAt: Date; _id: Types.ObjectId },
): Record<string, unknown> {
  const base: Record<string, unknown> = { group: channelName };
  if (!cursor) {
    return base;
  }

  return {
    group: channelName,
    $or: [
      { createdAt: { $lt: cursor.createdAt } },
      { createdAt: cursor.createdAt, _id: { $lt: cursor._id } },
    ],
  };
}
