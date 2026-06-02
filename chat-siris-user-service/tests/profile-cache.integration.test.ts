import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { signInternalRequest } from "@chat-siris/logger";
import {
  createApp,
  connectMongo,
  resetRedisClient,
  setRedisClient,
} from "../src/index";
import { ProfileModel } from "../src/models/profile.model";
import { profileCacheKey } from "../src/services/profile-cache.service";
import { createMemoryRedis } from "./helpers/memory-redis";

const HMAC_SECRET = "test-hmac-secret-for-integration";

describe("profile cache integration", () => {
  let mongoServer: MongoMemoryServer;
  const redis = createMemoryRedis();
  const app = createApp();

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    process.env.MONGODB_URI = mongoServer.getUri();
    process.env.MONGODB_DB_NAME = "chat_users_test";
    setRedisClient(redis);
    await connectMongo();
    await ProfileModel.syncIndexes();
  });

  afterAll(async () => {
    await mongoose.disconnect();
    resetRedisClient();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await mongoose.connection.db?.dropDatabase();
    await ProfileModel.syncIndexes();
    await redis.flushdb();
  });

  it("caches profile on GET and serves from Redis on second fetch", async () => {
    const userId = new mongoose.Types.ObjectId().toString();
    const createPath = "/internal/users";
    const createSig = signInternalRequest("POST", createPath, HMAC_SECRET);

    await request(app)
      .post(createPath)
      .set("X-Internal-Signature", createSig.signature)
      .set("X-Internal-Timestamp", String(createSig.timestamp))
      .send({
        _id: userId,
        username: "cacheduser",
        avatarImage: "img",
        isAvatarImageSet: false,
      });

    const getPath = `/internal/users/${userId}`;
    const getSig = signInternalRequest("GET", getPath, HMAC_SECRET);

    await request(app)
      .get(getPath)
      .set("X-Internal-Signature", getSig.signature)
      .set("X-Internal-Timestamp", String(getSig.timestamp));

    const cached = await redis.get(profileCacheKey(userId));
    expect(cached).not.toBeNull();

    await mongoose.connection.db?.dropDatabase();

    const getSig2 = signInternalRequest("GET", getPath, HMAC_SECRET);
    const res = await request(app)
      .get(getPath)
      .set("X-Internal-Signature", getSig2.signature)
      .set("X-Internal-Timestamp", String(getSig2.timestamp));

    expect(res.status).toBe(200);
    expect(res.body.username).toBe("cacheduser");
  });

  it("refreshes cache after profile update", async () => {
    const userId = new mongoose.Types.ObjectId().toString();
    const createPath = "/internal/users";
    const createSig = signInternalRequest("POST", createPath, HMAC_SECRET);

    await request(app)
      .post(createPath)
      .set("X-Internal-Signature", createSig.signature)
      .set("X-Internal-Timestamp", String(createSig.timestamp))
      .send({
        _id: userId,
        username: "before",
        avatarImage: "",
        isAvatarImageSet: false,
      });

    const updatePath = `/internal/users/${userId}/profile`;
    const updateSig = signInternalRequest("POST", updatePath, HMAC_SECRET);
    await request(app)
      .post(updatePath)
      .set("X-Internal-Signature", updateSig.signature)
      .set("X-Internal-Timestamp", String(updateSig.timestamp))
      .set("X-User-Id", userId)
      .send({ username: "after" });

    const cached = await redis.get(profileCacheKey(userId));
    expect(cached).toContain('"username":"after"');
  });
});
