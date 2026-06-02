import Redis from "ioredis";
import {
  createLogger,
  resolveEventsDbIndex,
  resolveEventsRedisUrl,
} from "@chat-siris/logger";
import { invalidateProfileCache } from "./profile-cache.service";

const logger = createLogger(process.env.SERVICE_NAME ?? "user-service");

let eventsSubscriber: Redis | null = null;
let subscriberStarted = false;

type ChannelMemberEvent = {
  event?: string;
  channelId?: string;
  channelName?: string;
  userId?: string;
};

function hasEventsRedisConfig(): boolean {
  return Boolean(
    process.env.REDIS_EVENTS_URL?.trim() || process.env.REDIS_URL?.trim(),
  );
}

function createEventsSubscriberClient(): Redis {
  const url = resolveEventsRedisUrl();
  return new Redis(url, {
    db: resolveEventsDbIndex(),
    maxRetriesPerRequest: null,
    lazyConnect: true,
    tls: url.startsWith("rediss://") ? {} : undefined,
  });
}

export async function startChannelEventSubscriber(): Promise<void> {
  if (subscriberStarted || !hasEventsRedisConfig()) {
    return;
  }

  subscriberStarted = true;
  eventsSubscriber = createEventsSubscriberClient();
  await eventsSubscriber.connect();
  await eventsSubscriber.subscribe("channel.member.changed");
  eventsSubscriber.on("message", (_channel, message) => {
    void handleChannelMemberChanged(message);
  });
  logger.info("channel event subscriber started");
}

async function handleChannelMemberChanged(message: string): Promise<void> {
  try {
    const payload = JSON.parse(message) as ChannelMemberEvent;
    if (payload.userId) {
      await invalidateProfileCache(payload.userId);
    }
  } catch {
    /* ignore malformed pub/sub payloads */
  }
}

export async function stopChannelEventSubscriber(): Promise<void> {
  if (eventsSubscriber?.status === "ready") {
    await eventsSubscriber.quit();
  }
  eventsSubscriber = null;
  subscriberStarted = false;
}

export function setEventsSubscriber(client: Redis | null): void {
  eventsSubscriber = client;
  subscriberStarted = client !== null;
}
