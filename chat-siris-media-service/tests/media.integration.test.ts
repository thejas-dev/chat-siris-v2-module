import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { signInternalRequest } from "@chat-siris/logger";
import ImageKit from "imagekit";
import {
  createApp,
  connectMongo,
  setCacheRedisClient,
  resetRedisClients,
} from "../src/index";
import { MediaAssetModel } from "../src/models/media-asset.model";
import { resetUploadRateLimiter } from "../src/routes/internal.routes";
import { setImageKitClient } from "../src/services/imagekit.service";
import { createMemoryRedis } from "./helpers/memory-redis";

const HMAC_SECRET = "test-hmac-secret-media";
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

const enqueueMediaJob = vi.fn(async () => undefined);

vi.mock("../src/services/queue.service", () => ({
  enqueueMediaJob: (...args: unknown[]) => enqueueMediaJob(...args),
  getMediaQueue: vi.fn(),
  closeMediaQueue: vi.fn(),
}));

describe("media-service integration", () => {
  let mongoServer: MongoMemoryServer;
  const app = createApp();

  beforeAll(async () => {
    process.env.INTERNAL_HMAC_SECRET = HMAC_SECRET;
    process.env.REDIS_URL = "redis://127.0.0.1:6379";
    process.env.IMAGEKIT_PUBLIC_KEY = "test_public_key";
    process.env.IMAGEKIT_PRIVATE_KEY = "test_private_key";
    process.env.IMAGEKIT_URL_ENDPOINT = "https://ik.imagekit.io/test";

    setImageKitClient({
      getAuthenticationParameters: (token: string, expire: number) => ({
        token,
        expire,
        signature: "mock-signature",
      }),
    } as unknown as ImageKit);

    mongoServer = await MongoMemoryServer.create();
    process.env.MONGODB_URI = mongoServer.getUri();
    process.env.MONGODB_DB_NAME = "chat_media_test";
    await connectMongo();
    await MediaAssetModel.syncIndexes();
  });

  afterAll(async () => {
    resetRedisClients();
    resetUploadRateLimiter();
    setImageKitClient(null);
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await mongoose.connection.db?.dropDatabase();
    await MediaAssetModel.syncIndexes();
    const cache = createMemoryRedis();
    await cache.flushdb();
    setCacheRedisClient(cache);
    enqueueMediaJob.mockClear();
    resetUploadRateLimiter();
  });

  it("P34-F-35: upload-init returns UploadInitResponse shape", async () => {
    const path = "/internal/media/upload-init";
    const res = await request(app)
      .post(path)
      .set(gatewayHeaders("POST", path))
      .send({
        fileName: "photo.jpg",
        mimeType: "image/jpeg",
        folder: "Images",
        sizeBytes: 1024,
      });

    expect(res.status).toBe(200);
    expect(res.body.uploadId).toBeDefined();
    expect(res.body.signature).toBe("mock-signature");
    expect(res.body.token).toBeDefined();
    expect(typeof res.body.expire).toBe("number");
    expect(res.body.folder).toBe("Images");
    expect(res.body.publicKey).toBe("test_public_key");

    const asset = await MediaAssetModel.findOne({ uploadId: res.body.uploadId });
    expect(asset?.status).toBe("initiated");
    expect(asset?.userId).toBe(USER_ID);
  });

  it("P34-F-39: video file exceeding 16 MB returns 413", async () => {
    const path = "/internal/media/upload-init";
    const res = await request(app)
      .post(path)
      .set(gatewayHeaders("POST", path))
      .send({
        fileName: "clip.mp4",
        mimeType: "video/mp4",
        folder: "Videos",
        sizeBytes: 16 * 1024 * 1024 + 1,
      });

    expect(res.status).toBe(413);
    expect(res.body.status).toBe(false);
    expect(await MediaAssetModel.countDocuments()).toBe(0);
  });

  it("P34-F-40: non-video file exceeding 25 MB returns 413", async () => {
    const path = "/internal/media/upload-init";
    const res = await request(app)
      .post(path)
      .set(gatewayHeaders("POST", path))
      .send({
        fileName: "archive.zip",
        mimeType: "application/zip",
        folder: "Zips",
        sizeBytes: 25 * 1024 * 1024 + 1,
      });

    expect(res.status).toBe(413);
    expect(res.body.status).toBe(false);
    expect(await MediaAssetModel.countDocuments()).toBe(0);
  });

  it("P34-F-41: 21st upload-init within 1 hour returns 429", async () => {
    const path = "/internal/media/upload-init";
    const headers = gatewayHeaders("POST", path);
    const body = {
      fileName: "photo.jpg",
      mimeType: "image/jpeg",
      folder: "Images",
      sizeBytes: 1024,
    };

    for (let i = 0; i < 20; i += 1) {
      const res = await request(app).post(path).set(headers).send(body);
      expect(res.status).toBe(200);
    }

    const blocked = await request(app).post(path).set(headers).send(body);
    expect(blocked.status).toBe(429);
    expect(blocked.body.status).toBe(false);
  });

  it("P34-F-37: upload-complete returns status true and url", async () => {
    const initPath = "/internal/media/upload-init";
    const initRes = await request(app)
      .post(initPath)
      .set(gatewayHeaders("POST", initPath))
      .send({
        fileName: "photo.jpg",
        mimeType: "image/jpeg",
        folder: "Images",
        sizeBytes: 1024,
      });

    const uploadId = initRes.body.uploadId as string;
    const cdnUrl = "https://ik.imagekit.io/test/Images/photo.jpg";
    const completePath = "/internal/media/upload-complete";
    const res = await request(app)
      .post(completePath)
      .set(gatewayHeaders("POST", completePath))
      .send({ uploadId, url: cdnUrl });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: true, url: cdnUrl });
    expect(enqueueMediaJob).toHaveBeenCalledWith(
      expect.objectContaining({
        uploadId,
        sourceUrl: cdnUrl,
        userId: USER_ID,
      }),
    );
  });

  it("P34-F-38: unknown uploadId on upload-complete returns 404", async () => {
    const path = "/internal/media/upload-complete";
    const res = await request(app)
      .post(path)
      .set(gatewayHeaders("POST", path))
      .send({
        uploadId: "00000000-0000-0000-0000-000000000000",
        url: "https://ik.imagekit.io/test/Images/missing.jpg",
      });

    expect(res.status).toBe(404);
    expect(res.body.status).toBe(false);
  });

  it("P34-F-44: upload-complete persists media_assets with status completed", async () => {
    const initPath = "/internal/media/upload-init";
    const initRes = await request(app)
      .post(initPath)
      .set(gatewayHeaders("POST", initPath))
      .send({
        fileName: "doc.pdf",
        mimeType: "application/pdf",
        folder: "Pdfs",
        sizeBytes: 2048,
      });

    const uploadId = initRes.body.uploadId as string;
    const cdnUrl = "https://ik.imagekit.io/test/Pdfs/doc.pdf";
    const completePath = "/internal/media/upload-complete";
    await request(app)
      .post(completePath)
      .set(gatewayHeaders("POST", completePath))
      .send({ uploadId, url: cdnUrl });

    const asset = await MediaAssetModel.findOne({ uploadId });
    expect(asset?.status).toBe("completed");
    expect(asset?.url).toBe(cdnUrl);
    expect(asset?.mimeType).toBe("application/pdf");
    expect(asset?.folder).toBe("Pdfs");
  });

  it("rejects invalid folder with 400", async () => {
    const path = "/internal/media/upload-init";
    const res = await request(app)
      .post(path)
      .set(gatewayHeaders("POST", path))
      .send({
        fileName: "photo.jpg",
        mimeType: "image/jpeg",
        folder: "InvalidFolder",
        sizeBytes: 1024,
      });

    expect(res.status).toBe(400);
    expect(res.body.status).toBe(false);
  });
});
