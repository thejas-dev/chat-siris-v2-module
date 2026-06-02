import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  cacheProfile,
  getCachedProfile,
  invalidateProfileCache,
  profileCacheKey,
} from "../src/services/profile-cache.service";
import { resetRedisClient, setRedisClient } from "../src/redis";
import type { ProfileJson } from "../src/models/profile.model";
import { createMemoryRedis } from "./helpers/memory-redis";

const sampleProfile: ProfileJson = {
  _id: "6a1882ebeb62f0968b509ee2",
  username: "alice",
  avatarImage: "a.png",
  isAvatarImageSet: true,
  backgroundImage: "",
  admin: "",
  inChannel: "general",
  createdAt: new Date("2024-01-01T00:00:00.000Z"),
  updatedAt: new Date("2024-01-02T00:00:00.000Z"),
};

describe("profile cache", () => {
  const redis = createMemoryRedis();

  beforeEach(() => {
    setRedisClient(redis);
  });

  afterEach(async () => {
    await redis.flushdb();
    resetRedisClient();
  });

  it("stores and retrieves profile at chat:user:{userId}", async () => {
    await cacheProfile(sampleProfile);

    const cached = await getCachedProfile(sampleProfile._id);
    expect(cached).toEqual({
      ...sampleProfile,
      createdAt: sampleProfile.createdAt.toISOString(),
      updatedAt: sampleProfile.updatedAt.toISOString(),
    });

    const ttl = await redis.ttl(profileCacheKey(sampleProfile._id));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(300);
  });

  it("invalidates cached profile on update", async () => {
    await cacheProfile(sampleProfile);
    await invalidateProfileCache(sampleProfile._id);

    const cached = await getCachedProfile(sampleProfile._id);
    expect(cached).toBeNull();
  });
});
