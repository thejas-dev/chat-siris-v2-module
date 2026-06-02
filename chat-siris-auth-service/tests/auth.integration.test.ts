import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { Express } from "express";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import jwt from "jsonwebtoken";
import { signInternalRequest } from "@chat-siris/logger";
import {
  createApp,
  connectMongo,
  setRedisClient,
  resetRedisClient,
} from "../src/index";
import { IdentityModel } from "../src/models/identity.model";
import { createMemoryRedis } from "./helpers/memory-redis";
import { TEST_JWT_PRIVATE_KEY, TEST_JWT_PUBLIC_KEY } from "./helpers/test-keys";
import type { Profile } from "../src/services/user-client.service";

const HMAC_SECRET = "test-hmac-secret-for-integration";
const USER_SERVICE_URL = "http://user-service.test";

const profiles = new Map<string, Profile>();
const usernames = new Set<string>();

function mockProfile(userId: string, overrides: Partial<Profile> = {}): Profile {
  const profile: Profile = {
    _id: userId,
    username: overrides.username ?? "testuser",
    avatarImage: overrides.avatarImage ?? "",
    isAvatarImageSet: overrides.isAvatarImageSet ?? false,
    backgroundImage: "",
    admin: "",
    inChannel: "",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
  profiles.set(userId, profile);
  usernames.add(profile.username);
  return profile;
}

function signedIntrospect(): { signature: string; timestamp: number } {
  return signInternalRequest(
    "POST",
    "/internal/token/introspect",
    HMAC_SECRET,
  );
}

vi.stubGlobal(
  "fetch",
  vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";

    if (method === "GET" && url.includes("/internal/users/")) {
      const id = url.split("/internal/users/")[1]?.split("?")[0] ?? "";
      const profile = profiles.get(id);
      if (!profile) {
        return new Response(
          JSON.stringify({ error: { code: "CHAT4040001" } }),
          { status: 404 },
        );
      }
      return new Response(JSON.stringify(profile), { status: 200 });
    }

    if (method === "POST" && url.endsWith("/internal/users")) {
      const body = JSON.parse(init?.body as string) as {
        _id: string;
        username: string;
        avatarImage: string;
        isAvatarImageSet: boolean;
      };
      if (usernames.has(body.username)) {
        return new Response(
          JSON.stringify({ error: { code: "CHAT4090001" } }),
          { status: 409 },
        );
      }
      if (url.includes("fail-profile")) {
        return new Response(
          JSON.stringify({ error: { code: "CHAT5030001" } }),
          { status: 503 },
        );
      }
      const profile = mockProfile(body._id, {
        username: body.username,
        avatarImage: body.avatarImage,
        isAvatarImageSet: body.isAvatarImageSet,
      });
      return new Response(JSON.stringify(profile), { status: 201 });
    }

    return new Response("not found", { status: 404 });
  }),
);

vi.mock("google-auth-library", () => ({
  OAuth2Client: vi.fn().mockImplementation(() => ({
    verifyIdToken: vi.fn(async ({ idToken }: { idToken: string }) => {
      if (idToken === "valid-google-token") {
        return {
          getPayload: () => ({
            email: "google@example.com",
            sub: "google-sub-123",
          }),
        };
      }
      throw new Error("invalid token");
    }),
  })),
}));

describe("auth-service internal routes", () => {
  let mongoServer: MongoMemoryServer;
  let app: Express.Application;
  let memoryRedis: ReturnType<typeof createMemoryRedis>;

  beforeAll(async () => {
    process.env.JWT_PRIVATE_KEY = TEST_JWT_PRIVATE_KEY;
    process.env.JWT_PUBLIC_KEY = TEST_JWT_PUBLIC_KEY;
    process.env.INTERNAL_HMAC_SECRET = HMAC_SECRET;
    process.env.USER_SERVICE_URL = USER_SERVICE_URL;
    process.env.GOOGLE_CLIENT_ID = "test-google-client-id";
    process.env.REDIS_URL = "redis://localhost:6379";

    mongoServer = await MongoMemoryServer.create();
    process.env.MONGODB_URI = mongoServer.getUri();
    process.env.MONGODB_DB_NAME = "chat_auth_test";
    await connectMongo();
    await IdentityModel.syncIndexes();

    memoryRedis = createMemoryRedis();
    setRedisClient(memoryRedis);
    app = await createApp();
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
    resetRedisClient();
    vi.unstubAllGlobals();
  });

  beforeEach(async () => {
    await mongoose.connection.db?.dropDatabase();
    await IdentityModel.syncIndexes();
    profiles.clear();
    usernames.clear();
    await memoryRedis.flushdb();
  });

  it("login returns user, accessToken, and refresh cookie for known email", async () => {
    const identity = await IdentityModel.create({ email: "user@example.com" });
    mockProfile(identity._id.toString(), {
      username: "alice",
      avatarImage: "https://img.test/a.png",
      isAvatarImageSet: true,
    });

    const res = await request(app)
      .post("/internal/login")
      .send({ email: "user@example.com" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(true);
    expect(res.body.accessToken).toBeTypeOf("string");
    expect(res.body.refreshToken).toBeTypeOf("string");
    expect(res.headers["set-cookie"]?.[0]).toMatch(/refreshToken=/);
    expect(res.body.user).toEqual({
      _id: identity._id.toString(),
      username: "alice",
      email: "user@example.com",
      avatarImage: "https://img.test/a.png",
      isAvatarImageSet: true,
      backgroundImage: "",
      admin: "",
      inChannel: "",
    });
  });

  it("login returns exact legacy message for unknown email", async () => {
    const res = await request(app)
      .post("/internal/login")
      .send({ email: "missing@example.com" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: false,
      msg: "Account need to be Regitered",
    });
  });

  it("register creates identity and profile with matching _id", async () => {
    const res = await request(app).post("/internal/register").send({
      username: "newbie",
      email: "new@example.com",
      avatarImage: "avatar",
      isAvatarImageSet: true,
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(true);
    expect(res.body.accessToken).toBeTypeOf("string");

    const identity = await IdentityModel.findOne({ email: "new@example.com" });
    expect(identity).not.toBeNull();
    expect(res.body.user._id).toBe(identity!._id.toString());
    expect(res.body.user.email).toBe("new@example.com");
  });

  it("register returns 409 for duplicate email", async () => {
    await IdentityModel.create({ email: "dup@example.com" });

    const res = await request(app).post("/internal/register").send({
      username: "user1",
      email: "dup@example.com",
      avatarImage: "",
      isAvatarImageSet: false,
    });

    expect(res.status).toBe(409);
    expect(res.body.status).toBe(false);
  });

  it("register returns 503 when user-service is unreachable", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError("fetch failed"));

    const res = await request(app).post("/internal/register").send({
      username: "offline",
      email: "offline@example.com",
      avatarImage: "",
      isAvatarImageSet: false,
    });

    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      status: false,
      msg: "Service temporarily unavailable",
    });

    const count = await IdentityModel.countDocuments({
      email: "offline@example.com",
    });
    expect(count).toBe(0);
  });

  it("register rolls back identity when profile creation fails with 503", async () => {
    process.env.USER_SERVICE_URL = "http://user-service.test/fail-profile";

    const res = await request(app).post("/internal/register").send({
      username: "orphan",
      email: "orphan@example.com",
      avatarImage: "",
      isAvatarImageSet: false,
    });

    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      status: false,
      msg: "Service temporarily unavailable",
    });

    const count = await IdentityModel.countDocuments({
      email: "orphan@example.com",
    });
    expect(count).toBe(0);

    process.env.USER_SERVICE_URL = USER_SERVICE_URL;
  });

  it("register returns 409 for duplicate username without orphan identity", async () => {
    const first = await request(app).post("/internal/register").send({
      username: "taken",
      email: "first@example.com",
      avatarImage: "",
      isAvatarImageSet: false,
    });
    expect(first.status).toBe(200);

    const res = await request(app).post("/internal/register").send({
      username: "taken",
      email: "second@example.com",
      avatarImage: "",
      isAvatarImageSet: false,
    });

    expect(res.status).toBe(409);
    const orphan = await IdentityModel.findOne({ email: "second@example.com" });
    expect(orphan).toBeNull();
  });

  it("oauth google succeeds with valid idToken", async () => {
    const res = await request(app)
      .post("/internal/oauth/google")
      .send({ idToken: "valid-google-token" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(true);
    expect(res.body.accessToken).toBeTypeOf("string");
    expect(res.body.user.email).toBe("google@example.com");
  });

  it("oauth google returns 401 for invalid idToken", async () => {
    const res = await request(app)
      .post("/internal/oauth/google")
      .send({ idToken: "bad-token" });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      status: false,
      msg: "Authentication required",
    });
  });

  it("issues RS256 access token with 900 second lifetime", async () => {
    const identity = await IdentityModel.create({ email: "jwt@example.com" });
    mockProfile(identity._id.toString());

    const res = await request(app)
      .post("/internal/login")
      .send({ email: "jwt@example.com" });

    const complete = jwt.decode(res.body.accessToken, { complete: true });
    const payload = complete?.payload as jwt.JwtPayload;
    expect(payload.exp! - payload.iat!).toBe(900);
    expect(complete?.header.alg).toBe("RS256");
  });

  it("refresh rotates token and rejects reuse", async () => {
    const identity = await IdentityModel.create({ email: "refresh@example.com" });
    mockProfile(identity._id.toString());

    const login = await request(app)
      .post("/internal/login")
      .send({ email: "refresh@example.com" });

    const firstRefresh = login.body.refreshToken as string;

    const res1 = await request(app)
      .post("/internal/token/refresh")
      .send({ refreshToken: firstRefresh });

    expect(res1.status).toBe(200);
    expect(res1.body.accessToken).toBeTypeOf("string");
    expect(res1.body.refreshToken).toBeTypeOf("string");

    const res2 = await request(app)
      .post("/internal/token/refresh")
      .send({ refreshToken: firstRefresh });

    expect(res2.status).toBe(401);
  });

  it("revoked refresh returns 401", async () => {
    const identity = await IdentityModel.create({ email: "revoke@example.com" });
    mockProfile(identity._id.toString());

    const login = await request(app)
      .post("/internal/login")
      .send({ email: "revoke@example.com" });

    const refreshToken = login.body.refreshToken as string;
    const accessToken = login.body.accessToken as string;

    await request(app)
      .post("/internal/token/revoke")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ refreshToken });

    const res = await request(app)
      .post("/internal/token/refresh")
      .send({ refreshToken });

    expect(res.status).toBe(401);
  });

  it("introspect requires HMAC and returns active claims", async () => {
    const identity = await IdentityModel.create({ email: "intro@example.com" });
    mockProfile(identity._id.toString());

    const login = await request(app)
      .post("/internal/login")
      .send({ email: "intro@example.com" });

    expect(login.status).toBe(200);
    expect(login.body.accessToken).toBeTypeOf("string");

    const noHmac = await request(app)
      .post("/internal/token/introspect")
      .send({ token: login.body.accessToken });

    expect(noHmac.status).toBe(401);

    const { signature, timestamp } = signedIntrospect();
    const res = await request(app)
      .post("/internal/token/introspect")
      .set("X-Internal-Signature", signature)
      .set("X-Internal-Timestamp", String(timestamp))
      .send({ token: login.body.accessToken });

    expect(res.status).toBe(200);
    expect(res.body.active).toBe(true);
    expect(res.body.sub).toBe(identity._id.toString());
    expect(res.body.email).toBe("intro@example.com");
    expect(res.body.jti).toBeTypeOf("string");
    expect(res.body.exp).toBeTypeOf("number");
  });

  it("login rate limit rejects 11th attempt from same IP", async () => {
    for (let i = 0; i < 10; i++) {
      await request(app)
        .post("/internal/login")
        .set("X-Forwarded-For", "203.0.113.50")
        .send({ email: `user${i}@example.com` });
    }

    const res = await request(app)
      .post("/internal/login")
      .set("X-Forwarded-For", "203.0.113.50")
      .send({ email: "blocked@example.com" });

    expect(res.status).toBe(429);
  });

  it("register rate limit rejects 6th attempt from same IP", async () => {
    for (let i = 0; i < 5; i++) {
      await request(app)
        .post("/internal/register")
        .set("X-Forwarded-For", "203.0.113.51")
        .send({
          username: `user${i}`,
          email: `reg${i}@example.com`,
          avatarImage: "",
          isAvatarImageSet: false,
        });
    }

    const res = await request(app)
      .post("/internal/register")
      .set("X-Forwarded-For", "203.0.113.51")
      .send({
        username: "blocked",
        email: "blocked@example.com",
        avatarImage: "",
        isAvatarImageSet: false,
      });

    expect(res.status).toBe(429);
  });
});
