import type { Request, Response } from "express";
import { MediaAssetModel } from "../models/media-asset.model";
import {
  FileTooLargeError,
  InvalidUploadBodyError,
  generateUploadParams,
  parseUploadInitBody,
} from "../services/imagekit.service";
import { enqueueMediaJob } from "../services/queue.service";
import { getTraceId, sendLegacyError } from "../middleware/hmac.middleware";

export async function uploadInit(req: Request, res: Response): Promise<void> {
  const userId = req.gatewayUserId;
  if (!userId) {
    sendLegacyError(res, 403, "Not authorized");
    return;
  }

  try {
    const body = parseUploadInitBody(req.body);
    const params = await generateUploadParams(userId, body);
    res.status(200).json(params);
  } catch (err) {
    if (err instanceof InvalidUploadBodyError) {
      sendLegacyError(res, err.statusCode, err.message);
      return;
    }
    if (err instanceof FileTooLargeError) {
      sendLegacyError(res, err.statusCode, err.message);
      return;
    }
    throw err;
  }
}

export async function uploadComplete(req: Request, res: Response): Promise<void> {
  const userId = req.gatewayUserId;
  if (!userId) {
    sendLegacyError(res, 403, "Not authorized");
    return;
  }

  const body = req.body as { uploadId?: unknown; url?: unknown };
  const uploadId = body.uploadId;
  const url = body.url;

  if (typeof uploadId !== "string" || uploadId.length === 0) {
    sendLegacyError(res, 400, "uploadId is required");
    return;
  }
  if (typeof url !== "string" || url.length === 0) {
    sendLegacyError(res, 400, "url is required");
    return;
  }

  const asset = await MediaAssetModel.findOne({ uploadId, userId });
  if (!asset) {
    sendLegacyError(res, 404, "Upload not found");
    return;
  }

  asset.url = url;
  asset.status = "completed";
  await asset.save();

  await enqueueMediaJob({
    uploadId,
    sourceUrl: url,
    mimeType: asset.mimeType,
    targetFolder: asset.folder,
    userId,
    requestId: getTraceId(req),
  });

  res.status(200).json({ status: true, url });
}
