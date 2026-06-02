import mongoose, { Schema, type Document, type Types } from "mongoose";

export interface IdentityDocument extends Document {
  _id: Types.ObjectId;
  email: string;
  googleSub?: string;
  createdAt: Date;
  updatedAt: Date;
}

export type IdentityJson = {
  _id: string;
  email: string;
  googleSub?: string;
  createdAt: Date;
  updatedAt: Date;
};

export function toIdentityJson(doc: IdentityDocument): IdentityJson {
  return {
    _id: doc._id.toString(),
    email: doc.email,
    ...(doc.googleSub ? { googleSub: doc.googleSub } : {}),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

const identitySchema = new Schema<IdentityDocument>(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    googleSub: { type: String, sparse: true, unique: true },
  },
  {
    timestamps: true,
    collection: "identities",
  },
);

export const IdentityModel = mongoose.model<IdentityDocument>(
  "Identity",
  identitySchema,
);
