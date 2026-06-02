import type { Server } from "socket.io";
import type { RedisClientType } from "redis";
import { createLogger } from "@chat-siris/logger";
import {
  PUBSUB_MESSAGE_CREATED,
  PUBSUB_MESSAGE_DELETED,
  PUBSUB_CHANNEL_UPDATED,
  PUBSUB_CHANNEL_MEMBER_CHANGED,
} from "../constants/pubsub-channels";
import { rememberMessageId } from "../services/anti-spoof-cache";
import { invalidateMembershipCache } from "../services/membership.service";
import type {
  MessageCreatedPayload,
  MessageDeletedPayload,
} from "./message.subscriber";

const logger = createLogger(process.env.SERVICE_NAME ?? "realtime-service");

type ChannelEventPayload = {
  channelName: string;
  userId?: string;
};

function legacyMsgReceivePayload(
  message: MessageCreatedPayload["message"],
): { status: true; data: MessageCreatedPayload["message"] } {
  return { status: true, data: message };
}

function roomSize(io: Server, room: string): number {
  return io.sockets.adapter.rooms.get(room)?.size ?? 0;
}

function handleMessageCreated(io: Server, raw: string): void {
  try {
    const payload = JSON.parse(raw) as MessageCreatedPayload;
    if (payload.channelName && payload.message) {
      void rememberMessageId(payload.message._id);
      const room = payload.channelName;
      const recipients = roomSize(io, room);
      io.to(room).emit(
        "msg-recieve",
        legacyMsgReceivePayload(payload.message),
      );
      logger.info("message.created fan-out", {
        channelName: room,
        messageId: payload.message._id,
        socketRecipients: recipients,
      });
      if (recipients === 0) {
        logger.warn("message.created: no sockets in room", {
          channelName: room,
        });
      }
    }
  } catch (err) {
    logger.warn("message.created handler failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function handleMessageDeleted(io: Server, raw: string): void {
  try {
    const payload = JSON.parse(raw) as MessageDeletedPayload;
    if (payload.channelName) {
      io.to(payload.channelName).emit("fetchMessages", payload.channelName);
    }
  } catch {
    /* ignore */
  }
}

function handleChannelEvent(io: Server, raw: string): void {
  try {
    const payload = JSON.parse(raw) as ChannelEventPayload;
    if (payload.channelName) {
      void invalidateMembershipCache(payload.channelName, payload.userId);
      io.emit("fetch");
    }
  } catch {
    /* ignore */
  }
}

export async function subscribeAllEvents(
  io: Server,
  subscriber: RedisClientType,
): Promise<void> {
  await subscriber.subscribe(PUBSUB_MESSAGE_CREATED, (message) => {
    handleMessageCreated(io, message);
  });
  await subscriber.subscribe(PUBSUB_MESSAGE_DELETED, (message) => {
    handleMessageDeleted(io, message);
  });
  await subscriber.subscribe(PUBSUB_CHANNEL_UPDATED, (message) => {
    handleChannelEvent(io, message);
  });
  await subscriber.subscribe(PUBSUB_CHANNEL_MEMBER_CHANGED, (message) => {
    handleChannelEvent(io, message);
  });

  logger.info("redis pub/sub subscribed", {
    channels: [
      PUBSUB_MESSAGE_CREATED,
      PUBSUB_MESSAGE_DELETED,
      PUBSUB_CHANNEL_UPDATED,
      PUBSUB_CHANNEL_MEMBER_CHANGED,
    ],
  });
}

export async function unsubscribeAllEvents(
  subscriber: RedisClientType,
): Promise<void> {
  await subscriber.unsubscribe(PUBSUB_MESSAGE_CREATED);
  await subscriber.unsubscribe(PUBSUB_MESSAGE_DELETED);
  await subscriber.unsubscribe(PUBSUB_CHANNEL_UPDATED);
  await subscriber.unsubscribe(PUBSUB_CHANNEL_MEMBER_CHANGED);
}
