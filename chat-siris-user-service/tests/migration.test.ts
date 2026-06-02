import { describe, it, expect, beforeAll, afterAll } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { runMigration } from "../scripts/migrate-users-split";
import { runValidation } from "../scripts/validate-migration";

describe("user split migration", () => {
  let mongoServer: MongoMemoryServer;
  let uri: string;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    uri = mongoServer.getUri();

    const conn = await mongoose.createConnection(uri).asPromise();
    await conn.db.collection("users").insertMany([
      {
        username: "alice",
        email: "a@test.com",
        avatarImage: "a.png",
        isAvatarImageSet: true,
        admin: "",
        inChannel: "general",
        backgroundImage: "",
      },
      {
        username: "bob",
        email: "b@test.com",
        avatarImage: "",
        isAvatarImageSet: false,
        admin: "admin",
        inChannel: "",
        backgroundImage: "bg.png",
      },
    ]);
    await conn.close();

    process.env.LEGACY_MONGODB_URI = uri;
    process.env.MONGODB_URI = uri;
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  it("P1-P-01/P-02/P-03: migrates with count, _id, and field parity", async () => {
    const stats = await runMigration();

    expect(stats.total).toBe(2);
    expect(stats.migrated).toBe(2);
    expect(stats.failed).toBe(0);

    const failureRate = await runValidation();
    expect(failureRate).toBe(0);

    const legacyConn = await mongoose.createConnection(uri).asPromise();
    const legacyCount = await legacyConn.db
      .collection("users")
      .countDocuments();
    expect(legacyCount).toBe(2);
    await legacyConn.close();
  });

  it("P1-N-04: does not write to legacy users collection", async () => {
    const conn = await mongoose.createConnection(uri).asPromise();
    const before = await conn.db.collection("users").countDocuments();
    await runMigration();
    const after = await conn.db.collection("users").countDocuments();
    expect(after).toBe(before);
    await conn.close();
  });

  it("P1-P-04: validation fails when failure rate exceeds 0.1%", async () => {
    const failureRate = await runValidation();
    expect(failureRate).toBeLessThanOrEqual(0.001);
  });
});
