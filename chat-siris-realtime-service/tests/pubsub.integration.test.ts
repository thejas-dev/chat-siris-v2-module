import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "http";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import {
  createSocketServer,
  resetRedisClients,
  setCacheRedisClient,
  setEventsRedisClient,
  setEventsSubscriberClient,
} from "../src/index";
import { createMemoryRedis } from "./helpers/memory-redis";
import { PUBSUB_MESSAGE_CREATED } from "../src/constants/pubsub-channels";

describe("realtime-service pub/sub integration", () => {
  let httpServer: http.Server;
  let port: number;
  let eventsRedis: ReturnType<typeof createMemoryRedis>;

  beforeAll(async () => {
    process.env.SOCKET_AUTH_REQUIRED = "false";
    process.env.SKIP_SOCKET_REDIS_ADAPTER = "true";
    process.env.REDIS_URL = "redis://127.0.0.1:6379";

    eventsRedis = createMemoryRedis();
    const cacheRedis = createMemoryRedis();
    setCacheRedisClient(cacheRedis as never);
    setEventsRedisClient(eventsRedis as never);
    setEventsSubscriberClient(eventsRedis as never);

    httpServer = http.createServer();
    await createSocketServer(httpServer);

    await new Promise<void>((resolve) => {
      httpServer.listen(0, () => {
        const addr = httpServer.address();
        port = typeof addr === "object" && addr ? addr.port : 0;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await resetRedisClients();
  });

  it("emits msg-recieve when message.created is published", async () => {
    const client: ClientSocket = ioClient(`http://127.0.0.1:${port}`, {
      transports: ["websocket"],
      extraHeaders: { "my-custom-header": "abcd" },
    });

    await new Promise<void>((resolve, reject) => {
      client.on("connect", () => resolve());
      client.on("connect_error", reject);
      setTimeout(() => reject(new Error("connect timeout")), 5000);
    });

    const channelName = "general";
    await new Promise<void>((resolve) => {
      client.emit("addUserToChannel", { name: channelName });
      setTimeout(resolve, 50);
    });

    const message = {
      _id: "674a1b2c3d4e5f6789012345",
      group: channelName,
      message: { text: "hello" },
      byUserName: "alice",
      byUserImage: "https://example.com/a.png",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const received = new Promise<unknown>((resolve) => {
      client.on("msg-recieve", (payload) => resolve(payload));
    });

    await eventsRedis.publish(
      PUBSUB_MESSAGE_CREATED,
      JSON.stringify({
        event: "message.created",
        requestId: "test-req",
        channelName,
        message,
        emittedAt: new Date().toISOString(),
      }),
    );

    const payload = await Promise.race([
      received,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("msg-recieve timeout")), 5000),
      ),
    ]);

    expect(payload).toEqual({ status: true, data: message });
    client.disconnect();
  });

  it("ignores add-msg when message id is not in anti-spoof cache", async () => {
    const client: ClientSocket = ioClient(`http://127.0.0.1:${port}`, {
      transports: ["websocket"],
      extraHeaders: { "my-custom-header": "abcd" },
    });

    await new Promise<void>((resolve, reject) => {
      client.on("connect", () => resolve());
      client.on("connect_error", reject);
      setTimeout(() => reject(new Error("connect timeout")), 5000);
    });

    let received = false;
    client.on("msg-recieve", () => {
      received = true;
    });

    client.emit("add-msg", {
      group: "general",
      data: { status: true, data: { _id: "spoof-id-not-cached" } },
    });

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(received).toBe(false);
    client.disconnect();
  });

  it("add-member emits userJoined to channel room (bug fix)", async () => {
    const client: ClientSocket = ioClient(`http://127.0.0.1:${port}`, {
      transports: ["websocket"],
      extraHeaders: { "my-custom-header": "abcd" },
    });

    await new Promise<void>((resolve, reject) => {
      client.on("connect", () => resolve());
      client.on("connect_error", reject);
      setTimeout(() => reject(new Error("connect timeout")), 5000);
    });

    const members = [{ _id: "user-2", username: "bob" }];
    const joined = new Promise<unknown>((resolve) => {
      client.on("userJoined", (payload) => resolve(payload));
    });

    client.emit("add-member", { channelName: "general", members });

    const payload = await Promise.race([
      joined,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("userJoined timeout")), 5000),
      ),
    ]);

    expect(payload).toEqual(members);
    client.disconnect();
  });
});
