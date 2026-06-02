import mongoose, { Schema, type Document, type Types } from "mongoose";

export interface SubscribeDocument extends Document {
  _id: Types.ObjectId;
  gmail: string;
  createdAt: Date;
  updatedAt: Date;
}

export type SubscribeJson = {
  _id: string;
  gmail: string;
  createdAt: Date;
  updatedAt: Date;
};

export function toSubscribeJson(doc: SubscribeDocument): SubscribeJson {
  return {
    _id: doc._id.toString(),
    gmail: doc.gmail,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

const subscribeSchema = new Schema<SubscribeDocument>(
  {
    gmail: { type: String, required: true },
  },
  {
    timestamps: true,
    collection: "subscribes",
  },
);

export const SubscribeModel = mongoose.model<SubscribeDocument>(
  "Subscribe",
  subscribeSchema,
);
