import { getEventsRedis } from "../redis";
import type { MessageJson } from "../models/message.model";

export type MessageCreatedEvent = {
  event: "message.created";
  requestId: string;
  channelName: string;
  message: MessageJson;
  emittedAt: string;
};

export type MessageDeletedEvent = {
  event: "message.deleted";
  requestId: string;
  channelName: string;
  messageId: string;
};

export async function publishMessageCreated(
  payload: MessageCreatedEvent,
): Promise<void> {
  try {
    const redis = await getEventsRedis();
    await redis.publish(payload.event, JSON.stringify(payload));
  } catch {
    /* pub/sub failure must not fail primary request */
  }
}

export async function publishMessageDeleted(
  payload: MessageDeletedEvent,
): Promise<void> {
  try {
    const redis = await getEventsRedis();
    await redis.publish(payload.event, JSON.stringify(payload));
  } catch {
    /* pub/sub failure must not fail primary request */
  }
}
