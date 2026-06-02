import mongoose, { Schema, type InferSchemaType } from "mongoose";

const mediaAssetSchema = new Schema(
  {
    uploadId: { type: String, required: true, unique: true, index: true },
    userId: { type: String, required: true, index: true },
    mimeType: { type: String, required: true },
    folder: { type: String, required: true },
    url: { type: String },
    status: {
      type: String,
      required: true,
      enum: ["initiated", "completed", "failed"],
      default: "initiated",
    },
    createdAt: { type: Date, required: true, default: Date.now },
  },
  { collection: "media_assets" },
);

export type MediaAssetDocument = InferSchemaType<typeof mediaAssetSchema> & {
  _id: mongoose.Types.ObjectId;
};

export const MediaAssetModel =
  mongoose.models.MediaAsset ??
  mongoose.model("MediaAsset", mediaAssetSchema);
