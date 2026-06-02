import mongoose, { Schema, type Document, type Types } from "mongoose";

export interface ProfileDocument extends Document {
  _id: Types.ObjectId;
  username: string;
  avatarImage: string;
  isAvatarImageSet: boolean;
  backgroundImage: string;
  admin: string;
  inChannel: string;
  createdAt: Date;
  updatedAt: Date;
}

export type ProfileJson = {
  _id: string;
  username: string;
  avatarImage: string;
  isAvatarImageSet: boolean;
  backgroundImage: string;
  admin: string;
  inChannel: string;
  createdAt: Date;
  updatedAt: Date;
};

export function toProfileJson(doc: ProfileDocument): ProfileJson {
  return {
    _id: doc._id.toString(),
    username: doc.username,
    avatarImage: doc.avatarImage,
    isAvatarImageSet: doc.isAvatarImageSet,
    backgroundImage: doc.backgroundImage,
    admin: doc.admin,
    inChannel: doc.inChannel,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

const profileSchema = new Schema<ProfileDocument>(
  {
    username: {
      type: String,
      required: true,
      minlength: 3,
      maxlength: 20,
      unique: true,
    },
    avatarImage: { type: String, default: "" },
    isAvatarImageSet: { type: Boolean, default: false },
    backgroundImage: { type: String, default: "" },
    admin: { type: String, default: "" },
    inChannel: { type: String, default: "" },
  },
  {
    timestamps: true,
    collection: "profiles",
  },
);

export const ProfileModel = mongoose.model<ProfileDocument>(
  "Profile",
  profileSchema,
);
