import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { signInternalRequest } from "@chat-siris/logger";
import { createApp, connectMongo } from "../src/index";
import { ProfileModel } from "../src/models/profile.model";
import { setRedisClient, resetRedisClient } from "../src/redis";
import { createMemoryRedis } from "./helpers/memory-redis";

const HMAC_SECRET = "test-hmac-secret-user-phase2";
const USER_ID = "507f1f77bcf86cd799439011";

function gatewayHeaders(method: string, path: string, userId = USER_ID) {
  const { signature, timestamp } = signInternalRequest(method, path, HMAC_SECRET);
  return {
    "X-Internal-Signature": signature,
    "X-Internal-Timestamp": String(timestamp),
    "X-User-Id": userId,
    "Content-Type": "application/json",
  };
}

describe("user-service Phase 2 gateway routes", () => {
  let mongoServer: MongoMemoryServer;
  const app = createApp();

  beforeAll(async () => {
    process.env.INTERNAL_HMAC_SECRET = HMAC_SECRET;
    setRedisClient(createMemoryRedis());
    mongoServer = await MongoMemoryServer.create();
    process.env.MONGODB_URI = mongoServer.getUri();
    process.env.MONGODB_DB_NAME = "chat_users_test";
    await connectMongo();
    await ProfileModel.syncIndexes();
  });

  afterAll(async () => {
    resetRedisClient();
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await mongoose.connection.db?.dropDatabase();
    await ProfileModel.syncIndexes();
    await ProfileModel.create({
      _id: new mongoose.Types.ObjectId(USER_ID),
      username: "testuser",
      avatarImage: "",
      isAvatarImageSet: false,
    });
  });

  it("P2-F-01: updateName success for own id", async () => {
    const path = `/internal/users/${USER_ID}/profile`;
    const res = await request(app)
      .post(path)
      .set(gatewayHeaders("POST", path))
      .send({ username: "newname" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(true);
    expect(res.body.obj.username).toBe("newname");
  });

  it("P2-F-02: updateName forbidden for other id", async () => {
    const otherId = new mongoose.Types.ObjectId().toString();
    const path = `/internal/users/${otherId}/profile`;
    const res = await request(app)
      .post(path)
      .set(gatewayHeaders("POST", path))
      .send({ username: "newname" });

    expect(res.status).toBe(403);
    expect(res.body.status).toBe(false);
  });

  it("P2-F-17: subscribe creates document", async () => {
    const path = "/internal/subscribe";
    const res = await request(app)
      .post(path)
      .set(gatewayHeaders("POST", path))
      .send({ gmail: "user@gmail.com" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(true);
    expect(res.body.subscribe.gmail).toBe("user@gmail.com");
  });
});
