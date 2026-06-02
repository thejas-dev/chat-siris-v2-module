/** Redis pub/sub channel names (DB 1) — must match message-service / group-service publishers */
export const PUBSUB_MESSAGE_CREATED = "message.created";
export const PUBSUB_MESSAGE_DELETED = "message.deleted";
export const PUBSUB_CHANNEL_UPDATED = "channel.updated";
export const PUBSUB_CHANNEL_MEMBER_CHANGED = "channel.member.changed";

export const PUBSUB_CHANNELS = [
  PUBSUB_MESSAGE_CREATED,
  PUBSUB_MESSAGE_DELETED,
  PUBSUB_CHANNEL_UPDATED,
  PUBSUB_CHANNEL_MEMBER_CHANGED,
] as const;
