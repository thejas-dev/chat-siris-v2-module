import type { Request, Response } from "express";
import mongoose from "mongoose";
import {
  MessageModel,
  buildOlderThanQuery,
  cursorFromMessage,
  normalizeGroupName,
  toMessageJson,
} from "../models/message.model";
import { sendLegacyError } from "../middleware/hmac.middleware";
import {
  authorizeDelete,
  authorizeSend,
  channelExists,
} from "../services/authorize.client";
import {
  getCachedHistoryPage,
  invalidateHistoryCache,
  setCachedHistoryPage,
} from "../services/message-cache.service";
import {
  publishMessageCreated,
  publishMessageDeleted,
} from "../services/pubsub.publisher";
import { enqueueNotification } from "../services/queue.service";
import { clampHistoryLimit, decodeCursor, encodeCursor } from "../utils/cursor";

type SendBody = {
  group?: unknown;
  message?: string | { text?: string };
  byUserName?: string;
  byUserImage?: string;
};

type HistoryBody = {
  group?: unknown;
  limit?: number;
  before?: string;
};

type DeleteBody = {
  id?: string;
};

function extractMessageText(body: SendBody): string | null {
  if (typeof body.message === "string" && body.message.length > 0) {
    return body.message;
  }
  if (
    typeof body.message === "object" &&
    body.message !== null &&
    typeof body.message.text === "string" &&
    body.message.text.length > 0
  ) {
    return body.message.text;
  }
  return null;
}

function serviceUnavailable(res: Response): void {
  sendLegacyError(res, 503, "Service temporarily unavailable");
}

export async function sendMessage(req: Request, res: Response): Promise<void> {
  const userId = req.gatewayUserId;
  if (!userId) {
    sendLegacyError(res, 403, "Not authorized");
    return;
  }

  const body = req.body as SendBody;
  const group = normalizeGroupName(body.group);
  const text = extractMessageText(body);
  const requestId = req.logContext?.requestId ?? "unknown";

  if (!group || !text || !body.byUserName || !body.byUserImage) {
    sendLegacyError(res, 400, "group, message, byUserName, and byUserImage are required");
    return;
  }

  const authz = await authorizeSend(userId, group, requestId);
  if (authz.status === "unavailable") {
    serviceUnavailable(res);
    return;
  }
  if (authz.status === "not_found") {
    sendLegacyError(res, 404, "Channel not found");
    return;
  }
  if (authz.status === "denied" || !authz.response.allowed) {
    sendLegacyError(res, 403, "Not allowed to post in this channel");
    return;
  }

  const doc = await MessageModel.create({
    group,
    message: { text },
    byUserName: body.byUserName,
    byUserImage: body.byUserImage,
  });

  const message = toMessageJson(doc);
  await invalidateHistoryCache(group);

  await publishMessageCreated({
    event: "message.created",
    requestId,
    channelName: group,
    message,
    emittedAt: new Date().toISOString(),
  });

  await enqueueNotification({
    messageId: message._id,
    channelName: group,
    senderId: userId,
    senderName: body.byUserName,
    previewText: text.slice(0, 120),
    requestId,
  });

  res.json({ status: true, data: message });
}

export async function getMessageHistory(
  req: Request,
  res: Response,
): Promise<void> {
  const userId = req.gatewayUserId;
  if (!userId) {
    sendLegacyError(res, 403, "Not authorized");
    return;
  }

  const body = req.body as HistoryBody;
  const group = normalizeGroupName(body.group);
  const requestId = req.logContext?.requestId;

  if (!group) {
    sendLegacyError(res, 400, "group is required");
    return;
  }

  const limit = clampHistoryLimit(body.limit);
  const beforeToken = body.before;

  if (!beforeToken) {
    const cached = await getCachedHistoryPage(group);
    if (cached) {
      res.json({ status: true, data: cached.data, pagination: cached.pagination });
      return;
    }
  }

  const exists = await channelExists(group, userId, requestId);
  if (exists === "unavailable") {
    serviceUnavailable(res);
    return;
  }
  if (!exists) {
    sendLegacyError(res, 404, "Channel not found");
    return;
  }

  let cursor: { createdAt: Date; _id: mongoose.Types.ObjectId } | undefined;
  if (beforeToken) {
    try {
      const decoded = decodeCursor(beforeToken);
      cursor = {
        createdAt: new Date(decoded.createdAt),
        _id: new mongoose.Types.ObjectId(decoded._id),
      };
    } catch {
      sendLegacyError(res, 400, "Invalid pagination cursor");
      return;
    }
  }

  const query = buildOlderThanQuery(group, cursor);
  const docs = await MessageModel.find(query)
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit + 1)
    .exec();

  const hasMore = docs.length > limit;
  const pageDocs = hasMore ? docs.slice(0, limit) : docs;
  const ascending = [...pageDocs].reverse();
  const data = ascending.map(toMessageJson);

  const nextCursor =
    hasMore && ascending.length > 0
      ? encodeCursor(cursorFromMessage(ascending[0]))
      : null;

  const pagination = {
    hasMore,
    nextCursor,
  };

  if (!beforeToken) {
    await setCachedHistoryPage(group, { data, pagination });
  }

  res.json({ status: true, data, pagination });
}

export async function deleteMessage(req: Request, res: Response): Promise<void> {
  const userId = req.gatewayUserId;
  if (!userId) {
    sendLegacyError(res, 403, "Not authorized");
    return;
  }

  const body = req.body as DeleteBody;
  const messageId = body.id;
  const requestId = req.logContext?.requestId ?? "unknown";

  if (!messageId || !mongoose.Types.ObjectId.isValid(messageId)) {
    sendLegacyError(res, 400, "Valid message id is required");
    return;
  }

  const existing = await MessageModel.findById(messageId);
  if (!existing) {
    sendLegacyError(res, 404, "Message not found");
    return;
  }

  const authz = await authorizeDelete(userId, existing.group, requestId);
  if (authz.status === "unavailable") {
    serviceUnavailable(res);
    return;
  }
  if (authz.status === "not_found") {
    sendLegacyError(res, 404, "Channel not found");
    return;
  }
  if (authz.status === "denied" || !authz.response.allowed) {
    sendLegacyError(res, 403, "Not allowed to delete this message");
    return;
  }

  const data = await MessageModel.deleteOne({ _id: messageId });
  await invalidateHistoryCache(existing.group);

  await publishMessageDeleted({
    event: "message.deleted",
    requestId,
    channelName: existing.group,
    messageId,
  });

  res.json({ status: true, data });
}
