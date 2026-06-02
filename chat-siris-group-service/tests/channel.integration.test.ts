import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { signInternalRequest } from "@chat-siris/logger";
import {
  createApp,
  connectMongo,
  setCacheRedisClient,
  setEventsRedisClient,
  resetRedisClients,
} from "../src/index";
import { GroupModel } from "../src/models/group.model";
import {
  createMemoryEventsRedis,
  createMemoryRedis,
} from "./helpers/memory-redis";

const HMAC_SECRET = "test-hmac-secret-group";
const USER_ID = "507f1f77bcf86cd799439011";

function gatewayHeaders(
  method: string,
  path: string,
  userId = USER_ID,
): Record<string, string> {
  const { signature, timestamp } = signInternalRequest(method, path, HMAC_SECRET);
  return {
    "X-Internal-Signature": signature,
    "X-Internal-Timestamp": String(timestamp),
    "X-User-Id": userId,
    "Content-Type": "application/json",
  };
}

vi.mock("../src/services/user-client.service", () => ({
  syncInChannel: vi.fn(async () => true),
}));

vi.mock("../src/services/queue.service", () => ({
  enqueueChannelSync: vi.fn(async () => undefined),
  getChannelSyncQueue: vi.fn(),
  closeChannelSyncQueue: vi.fn(),
}));

describe("group-service integration", () => {
  let mongoServer: MongoMemoryServer;
  const app = createApp();

  beforeAll(async () => {
    process.env.INTERNAL_HMAC_SECRET = HMAC_SECRET;
    process.env.REDIS_URL = "redis://127.0.0.1:6379";
    setCacheRedisClient(createMemoryRedis());
    setEventsRedisClient(createMemoryEventsRedis() as never);

    mongoServer = await MongoMemoryServer.create();
    process.env.MONGODB_URI = mongoServer.getUri();
    process.env.MONGODB_DB_NAME = "chat_groups_test";
    await connectMongo();
    await GroupModel.syncIndexes();
  });

  afterAll(async () => {
    resetRedisClients();
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await mongoose.connection.db?.dropDatabase();
    await GroupModel.syncIndexes();
    const redis = createMemoryRedis();
    await redis.flushdb();
    setCacheRedisClient(redis);
  });

  it("P2-F-05: createChannel success", async () => {
    const path = "/internal/channels";
    const res = await request(app)
      .post(path)
      .set(gatewayHeaders("POST", path))
      .send({
        name: "general",
        admin: "adminuser",
        adminId: USER_ID,
        description: "General chat",
        privacy: false,
        users: [],
        adminOnly: false,
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(true);
    expect(res.body.group.name).toBe("general");
  });

  it("rejects createChannel when adminId does not match logged-in user", async () => {
    const path = "/internal/channels";
    const res = await request(app)
      .post(path)
      .set(gatewayHeaders("POST", path))
      .send({
        name: "otheradmin",
        admin: "adminuser",
        adminId: new mongoose.Types.ObjectId().toString(),
        privacy: false,
      });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ status: false, msg: "Not authorized" });
  });

  it("P2-F-06: createChannel duplicate returns 409", async () => {
    const path = "/internal/channels";
    const headers = gatewayHeaders("POST", path);
    await request(app).post(path).set(headers).send({
      name: "dupchan",
      admin: "adminuser",
      adminId: USER_ID,
      privacy: false,
    });

    const res = await request(app)
      .post(path)
      .set(gatewayHeaders("POST", path))
      .send({
        name: "dupchan",
        admin: "adminuser",
        adminId: USER_ID,
        privacy: false,
      });

    expect(res.status).toBe(409);
    expect(res.body.status).toBe(false);
  });

  it("P2-F-07: getAllChannels returns public channels only", async () => {
    await GroupModel.create([
      {
        name: "public1",
        admin: "a",
        adminId: USER_ID,
        privacy: false,
      },
      {
        name: "private1",
        admin: "a",
        adminId: USER_ID,
        privacy: true,
      },
    ]);

    const path = "/internal/channels/public";
    const res = await request(app).get(path).set(gatewayHeaders("GET", path));

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].name).toBe("public1");
  });

  it("P2-F-12: wrong password returns Password Wrong", async () => {
    const channel = await GroupModel.create({
      name: "secret",
      admin: "a",
      adminId: USER_ID,
      password: "correct",
      privacy: true,
      users: [],
    });

    const path = `/internal/channels/${channel._id.toString()}/members`;
    const res = await request(app)
      .post(path)
      .set(gatewayHeaders("POST", path))
      .send({
        user: {
          _id: USER_ID,
          username: "member",
          avatarImage: "",
          isAvatarImageSet: false,
        },
        password: "wrong",
      });

    expect(res.status).toBe(403);
    expect(res.body.msg).toBe("Password Wrong");
  });

  it("P2-F-19: authorize NOT_MEMBER", async () => {
    const channel = await GroupModel.create({
      name: "authz",
      admin: "a",
      adminId: USER_ID,
      privacy: false,
      users: [],
    });

    const path = `/internal/channels/${channel._id.toString()}/authorize`;
    const queryPath = `${path}?userId=${USER_ID}&action=send`;
    const { signature, timestamp } = signInternalRequest("GET", path, HMAC_SECRET);

    const res = await request(app)
      .get(queryPath)
      .set("X-Internal-Signature", signature)
      .set("X-Internal-Timestamp", String(timestamp));

    expect(res.status).toBe(200);
    expect(res.body.allowed).toBe(false);
    expect(res.body.reason).toBe("NOT_MEMBER");
  });

  it("P2-F-21: authorize delete allowed for admin", async () => {
    const channel = await GroupModel.create({
      name: "admchan",
      admin: "a",
      adminId: USER_ID,
      privacy: false,
      users: [
        {
          _id: USER_ID,
          username: "admin",
          avatarImage: "",
          isAvatarImageSet: false,
        },
      ],
    });

    const path = `/internal/channels/${channel._id.toString()}/authorize`;
    const queryPath = `${path}?userId=${USER_ID}&action=delete`;
    const { signature, timestamp } = signInternalRequest("GET", path, HMAC_SECRET);

    const res = await request(app)
      .get(queryPath)
      .set("X-Internal-Signature", signature)
      .set("X-Internal-Timestamp", String(timestamp));

    expect(res.body.allowed).toBe(true);
  });
});
