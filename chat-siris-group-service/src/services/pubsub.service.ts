import { getEventsRedis } from "../redis";

export type ChannelEventPayload = {
  event: "channel.updated" | "channel.member.changed";
  requestId?: string;
  channelId: string;
  channelName: string;
  userId?: string;
  emittedAt: string;
};

export async function publishChannelEvent(
  payload: ChannelEventPayload,
): Promise<void> {
  try {
    const redis = await getEventsRedis();
    await redis.publish(payload.event, JSON.stringify(payload));
  } catch {
    /* pub/sub failure must not fail primary request */
  }
}

export async function publishMemberChanged(
  channelId: string,
  channelName: string,
  requestId?: string,
  userId?: string,
): Promise<void> {
  const emittedAt = new Date().toISOString();
  await publishChannelEvent({
    event: "channel.member.changed",
    requestId,
    channelId,
    channelName,
    userId,
    emittedAt,
  });
  await publishChannelEvent({
    event: "channel.updated",
    requestId,
    channelId,
    channelName,
    emittedAt,
  });
}
