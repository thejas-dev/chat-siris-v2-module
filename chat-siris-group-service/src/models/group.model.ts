import mongoose, { Schema, type Document, type Types } from "mongoose";

export type UserSnapshot = {
  _id: string;
  username: string;
  avatarImage: string;
  isAvatarImageSet: boolean;
};

export interface GroupDocument extends Document {
  _id: Types.ObjectId;
  name: string;
  admin: string;
  adminId: string;
  description?: string;
  password?: string;
  privacy: boolean;
  users: UserSnapshot[];
  adminOnly: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export type ChannelJson = {
  _id: string;
  name: string;
  admin: string;
  adminId: string;
  description?: string;
  password?: string;
  privacy: boolean;
  users: UserSnapshot[];
  adminOnly: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export function toChannelJson(doc: GroupDocument): ChannelJson {
  return {
    _id: doc._id.toString(),
    name: doc.name,
    admin: doc.admin,
    adminId: doc.adminId,
    description: doc.description,
    password: doc.password,
    privacy: doc.privacy,
    users: doc.users,
    adminOnly: doc.adminOnly,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

const userSnapshotSchema = new Schema<UserSnapshot>(
  {
    _id: { type: String, required: true },
    username: { type: String, required: true },
    avatarImage: { type: String, default: "" },
    isAvatarImageSet: { type: Boolean, default: false },
  },
  { _id: false },
);

const groupSchema = new Schema<GroupDocument>(
  {
    name: { type: String, required: true, minlength: 3, maxlength: 20, unique: true },
    admin: { type: String, required: true },
    adminId: { type: String, required: true },
    description: { type: String },
    password: { type: String },
    privacy: { type: Boolean, default: false },
    users: { type: [userSnapshotSchema], default: [] },
    adminOnly: { type: Boolean, default: false },
  },
  {
    timestamps: true,
    collection: "groups",
  },
);

export const GroupModel = mongoose.model<GroupDocument>("Group", groupSchema);
