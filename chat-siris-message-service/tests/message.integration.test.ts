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
import { MessageModel } from "../src/models/message.model";
import { resetSendRateLimiter } from "../src/routes/internal.routes";
import {
  createMemoryEventsRedis,
  createMemoryRedis,
} from "./helpers/memory-redis";
import type { AuthorizeOutcome } from "../src/services/authorize.client";

const HMAC_SECRET = "test-hmac-secret-message";
const USER_ID = "507f1f77bcf86cd799439011";
const CHANNEL_NAME = "general";

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

const authorizeSend = vi.fn<
  (userId: string, channelName: string, requestId?: string) => Promise<AuthorizeOutcome>
>();
const authorizeDelete = vi.fn<
  (userId: string, channelName: string, requestId?: string) => Promise<AuthorizeOutcome>
>();
const channelExists = vi.fn<
  (channelName: string, userId: string, requestId?: string) => Promise<boolean | "unavailable">
>();

vi.mock("../src/services/authorize.client", () => ({
  authorizeSend: (...args: Parameters<typeof authorizeSend>) => authorizeSend(...args),
  authorizeDelete: (...args: Parameters<typeof authorizeDelete>) =>
    authorizeDelete(...args),
  channelExists: (...args: Parameters<typeof channelExists>) => channelExists(...args),
}));

vi.mock("../src/services/queue.service", () => ({
  enqueueNotification: vi.fn(async () => undefined),
  getNotificationQueue: vi.fn(),
  closeNotificationQueue: vi.fn(),
}));

vi.mock("../src/middleware/rate-limit.middleware", () => ({
  createSendRateLimiter: vi.fn(async () => (_req: unknown, _res: unknown, next: () => void) => {
    next();
  }),
  resetRateLimitStore: vi.fn(),
}));

describe("message-service integration", () => {
  let mongoServer: MongoMemoryServer;
  let eventsRedis: ReturnType<typeof createMemoryEventsRedis>;
  const app = createApp();

  beforeAll(async () => {
    process.env.INTERNAL_HMAC_SECRET = HMAC_SECRET;
    process.env.REDIS_URL = "redis://127.0.0.1:6379";
    eventsRedis = createMemoryEventsRedis();
    setCacheRedisClient(createMemoryRedis());
    setEventsRedisClient(eventsRedis as never);

    mongoServer = await MongoMemoryServer.create();
    process.env.MONGODB_URI = mongoServer.getUri();
    process.env.MONGODB_DB_NAME = "chat_messages_test";
    await connectMongo();
    await MessageModel.syncIndexes();
  });

  afterAll(async () => {
    resetRedisClients();
    resetSendRateLimiter();
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await mongoose.connection.db?.dropDatabase();
    await MessageModel.syncIndexes();
    const cache = createMemoryRedis();
    await cache.flushdb();
    setCacheRedisClient(cache);
    eventsRedis = createMemoryEventsRedis();
    setEventsRedisClient(eventsRedis as never);
    authorizeSend.mockReset();
    authorizeDelete.mockReset();
    channelExists.mockReset();
    resetSendRateLimiter();

    channelExists.mockResolvedValue(true);
    authorizeSend.mockResolvedValue({ status: "ok", response: { allowed: true } });
    authorizeDelete.mockResolvedValue({ status: "ok", response: { allowed: true } });
  });

  it("P34-F-01: sendMessage persists message and publishes event", async () => {
    const path = "/internal/messages";
    const res = await request(app)
      .post(path)
      .set(gatewayHeaders("POST", path))
      .send({
        group: CHANNEL_NAME,
        message: "hello world",
        byUserName: "tester",
        byUserImage: "avatar.png",
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(true);
    expect(res.body.data.message.text).toBe("hello world");

    const count = await MessageModel.countDocuments();
    expect(count).toBe(1);

    const published = eventsRedis.getPublished();
    expect(published).toHaveLength(1);
    expect(published[0]?.channel).toBe("message.created");
    const payload = JSON.parse(published[0]?.message ?? "{}") as {
      event: string;
      channelName: string;
      message: { group: string };
    };
    expect(payload.event).toBe("message.created");
    expect(payload.channelName).toBe(CHANNEL_NAME);
    expect(payload.message.group).toBe(CHANNEL_NAME);
  });

  it("P34-F-02: sendMessage authz denied writes nothing", async () => {
    authorizeSend.mockResolvedValue({
      status: "denied",
      response: { allowed: false, reason: "NOT_MEMBER" },
    });

    const path = "/internal/messages";
    const res = await request(app)
      .post(path)
      .set(gatewayHeaders("POST", path))
      .send({
        group: CHANNEL_NAME,
        message: "blocked",
        byUserName: "tester",
        byUserImage: "avatar.png",
      });

    expect(res.status).toBe(403);
    expect(res.body.msg).toBe("Not allowed to post in this channel");
    expect(await MessageModel.countDocuments()).toBe(0);
    expect(eventsRedis.getPublished()).toHaveLength(0);
  });

  it("P34-N-06: authorize unavailable returns 503 without write", async () => {
    authorizeSend.mockResolvedValue({ status: "unavailable" });

    const path = "/internal/messages";
    const res = await request(app)
      .post(path)
      .set(gatewayHeaders("POST", path))
      .send({
        group: CHANNEL_NAME,
        message: "blocked",
        byUserName: "tester",
        byUserImage: "avatar.png",
      });

    expect(res.status).toBe(503);
    expect(await MessageModel.countDocuments()).toBe(0);
  });

  it("P34-F-03/F-05: getMessages returns pagination on initial load", async () => {
    const now = Date.now();
    for (let i = 0; i < 3; i++) {
      await MessageModel.create({
        group: CHANNEL_NAME,
        message: { text: `msg-${i}` },
        byUserName: "tester",
        byUserImage: "avatar.png",
        createdAt: new Date(now + i * 1000),
        updatedAt: new Date(now + i * 1000),
      });
    }

    const path = "/internal/messages/history";
    const res = await request(app)
      .post(path)
      .set(gatewayHeaders("POST", path))
      .send({ group: CHANNEL_NAME, limit: 50 });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(true);
    expect(res.body.data).toHaveLength(3);
    expect(res.body.pagination).toEqual({
      hasMore: false,
      nextCursor: null,
    });
  });

  it("P34-F-04/F-13: paginated history uses before cursor and skips cache", async () => {
    const docs = [];
    const base = Date.now();
    for (let i = 0; i < 5; i++) {
      docs.push(
        await MessageModel.create({
          group: CHANNEL_NAME,
          message: { text: `msg-${i}` },
          byUserName: "tester",
          byUserImage: "avatar.png",
          createdAt: new Date(base + i * 1000),
          updatedAt: new Date(base + i * 1000),
        }),
      );
    }

    const path = "/internal/messages/history";
    const initial = await request(app)
      .post(path)
      .set(gatewayHeaders("POST", path))
      .send({ group: CHANNEL_NAME, limit: 2 });

    expect(initial.body.pagination.hasMore).toBe(true);
    expect(initial.body.data).toHaveLength(2);

    const older = await request(app)
      .post(path)
      .set(gatewayHeaders("POST", path))
      .send({
        group: CHANNEL_NAME,
        limit: 2,
        before: initial.body.pagination.nextCursor,
      });

    expect(older.body.data).toHaveLength(2);
    expect(older.body.data[0].message.text).toBe("msg-1");
    expect(older.body.data[1].message.text).toBe("msg-2");
  });

  it("P34-F-07: unknown channel returns 404", async () => {
    channelExists.mockResolvedValue(false);
    const path = "/internal/messages/history";
    const res = await request(app)
      .post(path)
      .set(gatewayHeaders("POST", path))
      .send({ group: "missing" });

    expect(res.status).toBe(404);
    expect(res.body.msg).toBe("Channel not found");
  });

  it("P34-F-08/F-11: deleteMessage removes document and publishes deleted event", async () => {
    const doc = await MessageModel.create({
      group: CHANNEL_NAME,
      message: { text: "delete-me" },
      byUserName: "tester",
      byUserImage: "avatar.png",
    });

    const path = "/internal/messages/delete";
    const res = await request(app)
      .post(path)
      .set(gatewayHeaders("POST", path))
      .send({ id: doc._id.toString() });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(true);
    expect(await MessageModel.countDocuments()).toBe(0);

    const published = eventsRedis.getPublished();
    expect(published[0]?.channel).toBe("message.deleted");
    const payload = JSON.parse(published[0]?.message ?? "{}") as {
      event: string;
      messageId: string;
      channelName: string;
    };
    expect(payload.event).toBe("message.deleted");
    expect(payload.messageId).toBe(doc._id.toString());
    expect(payload.channelName).toBe(CHANNEL_NAME);
  });

  it("P34-F-09: deleteMessage non-admin returns 403", async () => {
    const doc = await MessageModel.create({
      group: CHANNEL_NAME,
      message: { text: "keep-me" },
      byUserName: "tester",
      byUserImage: "avatar.png",
    });

    authorizeDelete.mockResolvedValue({
      status: "denied",
      response: { allowed: false, reason: "NOT_CHANNEL_ADMIN" },
    });

    const path = "/internal/messages/delete";
    const res = await request(app)
      .post(path)
      .set(gatewayHeaders("POST", path))
      .send({ id: doc._id.toString() });

    expect(res.status).toBe(403);
    expect(await MessageModel.countDocuments()).toBe(1);
  });

  it("P34-F-12: latest page cache hit on repeat initial load", async () => {
    await MessageModel.create({
      group: CHANNEL_NAME,
      message: { text: "cached" },
      byUserName: "tester",
      byUserImage: "avatar.png",
    });

    const path = "/internal/messages/history";
    await request(app)
      .post(path)
      .set(gatewayHeaders("POST", path))
      .send({ group: CHANNEL_NAME });

    channelExists.mockResolvedValue(false);
    const cached = await request(app)
      .post(path)
      .set(gatewayHeaders("POST", path))
      .send({ group: CHANNEL_NAME });

    expect(cached.status).toBe(200);
    expect(cached.body.data[0].message.text).toBe("cached");
  });

  it("legacy getMessages body with group only remains valid", async () => {
    await MessageModel.create({
      group: CHANNEL_NAME,
      message: { text: "legacy" },
      byUserName: "tester",
      byUserImage: "avatar.png",
    });

    const path = "/internal/messages/history";
    const res = await request(app)
      .post(path)
      .set(gatewayHeaders("POST", path))
      .send({ group: CHANNEL_NAME });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
  });
});
