import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { signInternalRequest } from "@chat-siris/logger";
import { createApp, connectMongo } from "../src/index";
import { ProfileModel } from "../src/models/profile.model";

const HMAC_SECRET = "test-hmac-secret-for-integration";

function signedRequest(
  method: "GET" | "POST",
  path: string,
): { signature: string; timestamp: number } {
  return signInternalRequest(method, path, HMAC_SECRET);
}

describe("internal user routes", () => {
  let mongoServer: MongoMemoryServer;
  const app = createApp();

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    process.env.MONGODB_URI = mongoServer.getUri();
    process.env.MONGODB_DB_NAME = "chat_users_test";
    await connectMongo();
    await ProfileModel.syncIndexes();
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await mongoose.connection.db?.dropDatabase();
    await ProfileModel.syncIndexes();
  });

  it("rejects requests without HMAC with 401 CHAT4010001", async () => {
    const res = await request(app).get("/internal/users/507f1f77bcf86cd799439011");

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("CHAT4010001");
  });

  it("creates a profile via POST /internal/users", async () => {
    const path = "/internal/users";
    const { signature, timestamp } = signedRequest("POST", path);
    const userId = new mongoose.Types.ObjectId().toString();

    const res = await request(app)
      .post(path)
      .set("X-Internal-Signature", signature)
      .set("X-Internal-Timestamp", String(timestamp))
      .send({
        _id: userId,
        username: "testuser",
        email: "test@example.com",
        avatarImage: "https://example.com/avatar.png",
        isAvatarImageSet: true,
      });

    expect(res.status).toBe(201);
    expect(res.body._id).toBe(userId);
    expect(res.body.username).toBe("testuser");
    expect(res.body.avatarImage).toBe("https://example.com/avatar.png");
    expect(res.body.isAvatarImageSet).toBe(true);
    expect(res.body.backgroundImage).toBe("");
    expect(res.body.admin).toBe("");
    expect(res.body.inChannel).toBe("");
    expect(res.body.createdAt).toBeDefined();
    expect(res.body.updatedAt).toBeDefined();
  });

  it("returns 409 on duplicate username", async () => {
    const path = "/internal/users";
    const firstSig = signedRequest("POST", path);
    const first = await request(app)
      .post(path)
      .set("X-Internal-Signature", firstSig.signature)
      .set("X-Internal-Timestamp", String(firstSig.timestamp))
      .send({
        username: "dupuser",
        email: "first@example.com",
        avatarImage: "",
        isAvatarImageSet: false,
      });

    expect(first.status).toBe(201);

    const second = signedRequest("POST", path);
    const res = await request(app)
      .post(path)
      .set("X-Internal-Signature", second.signature)
      .set("X-Internal-Timestamp", String(second.timestamp))
      .send({
        username: "dupuser",
        email: "second@example.com",
        avatarImage: "",
        isAvatarImageSet: false,
      });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("CHAT4090001");
  });

  it("fetches a profile via GET /internal/users/:id", async () => {
    const userId = new mongoose.Types.ObjectId().toString();
    const createPath = "/internal/users";
    const createSig = signedRequest("POST", createPath);

    await request(app)
      .post(createPath)
      .set("X-Internal-Signature", createSig.signature)
      .set("X-Internal-Timestamp", String(createSig.timestamp))
      .send({
        _id: userId,
        username: "fetchme",
        email: "fetch@example.com",
        avatarImage: "img",
        isAvatarImageSet: false,
      });

    const getPath = `/internal/users/${userId}`;
    const getSig = signedRequest("GET", getPath);
    const res = await request(app)
      .get(getPath)
      .set("X-Internal-Signature", getSig.signature)
      .set("X-Internal-Timestamp", String(getSig.timestamp));

    expect(res.status).toBe(200);
    expect(res.body._id).toBe(userId);
    expect(res.body.username).toBe("fetchme");
  });

  it("returns 404 for missing profile", async () => {
    const missingId = new mongoose.Types.ObjectId().toString();
    const path = `/internal/users/${missingId}`;
    const { signature, timestamp } = signedRequest("GET", path);

    const res = await request(app)
      .get(path)
      .set("X-Internal-Signature", signature)
      .set("X-Internal-Timestamp", String(timestamp));

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("CHAT4040001");
  });
});
