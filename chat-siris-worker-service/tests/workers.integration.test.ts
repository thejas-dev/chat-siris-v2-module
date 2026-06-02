import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  isQueueLagDegraded,
} from "../src/workers/index";
import {
  isChannelSyncProcessed,
  markChannelSyncProcessed,
  setCacheRedisClient,
  resetCacheRedisClient,
} from "../src/redis";
import { channelSyncIdempotencyKey } from "../src/services/user-client.service";
import { createMemoryRedis } from "./helpers/memory-redis";

describe("worker-service", () => {
  beforeAll(() => {
    setCacheRedisClient(createMemoryRedis() as never);
  });

  afterAll(() => {
    resetCacheRedisClient();
  });

  it("marks queue lag degraded above threshold", () => {
    expect(isQueueLagDegraded({ "notification-queue": 500 })).toBe(false);
    expect(isQueueLagDegraded({ "media-queue": 1001 })).toBe(true);
  });

  it("channel-sync idempotency skips duplicate keys", async () => {
    const job = {
      userId: "507f1f77bcf86cd799439011",
      channelName: "general",
      action: "join" as const,
      requestId: "req-1",
    };
    const key = channelSyncIdempotencyKey(job);
    expect(await isChannelSyncProcessed(key)).toBe(false);
    await markChannelSyncProcessed(key);
    expect(await isChannelSyncProcessed(key)).toBe(true);
  });
});
