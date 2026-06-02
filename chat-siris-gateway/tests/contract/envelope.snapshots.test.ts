import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import { randomUUID } from "crypto";
import { createApp, setRedisClient, resetRedisClient } from "../../src/index";
import { createMemoryRedis } from "../helpers/memory-redis";
import { TEST_JWT_PRIVATE_KEY } from "../helpers/test-keys";
import { assertLegacyEnvelopeShape, pickLegacyEnvelope } from "./helpers/legacy-envelope";

function bearerToken(): string {
  return jwt.sign(
    { sub: "507f1f77bcf86cd799439011", email: "t@test.com", jti: randomUUID() },
    TEST_JWT_PRIVATE_KEY,
    { algorithm: "RS256", expiresIn: 900 },
  );
}

describe("Contract: legacy envelope snapshots (P5-N-02)", () => {
  let app: Awaited<ReturnType<typeof createApp>>;

  beforeAll(async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/internal/token/introspect")) {
          return new Response(
            JSON.stringify({
              active: true,
              sub: "507f1f77bcf86cd799439011",
              email: "t@test.com",
              jti: randomUUID(),
              exp: Math.floor(Date.now() / 1000) + 900,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ status: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
    setRedisClient(createMemoryRedis());
    app = await createApp({ skipRateLimit: true });
  });

  afterAll(() => {
    resetRedisClient();
    vi.unstubAllGlobals();
  });

  it("401 without JWT matches legacy envelope snapshot", async () => {
    const res = await request(app)
      .post("/api/auth/createChannel")
      .send({ name: "test" });

    expect(res.status).toBe(401);
    assertLegacyEnvelopeShape(res.body);
    expect(pickLegacyEnvelope(res.body)).toMatchInlineSnapshot(`
      {
        "msg": "Authentication required",
        "status": false,
      }
    `);
  });

  it("410 Tradity matches legacy envelope snapshot", async () => {
    const res = await request(app)
      .get("/api/auth/tradity")
      .set("Authorization", `Bearer ${bearerToken()}`);

    expect(res.status).toBe(410);
    assertLegacyEnvelopeShape(res.body);
    expect(pickLegacyEnvelope(res.body)).toMatchInlineSnapshot(`
      {
        "msg": "This endpoint has been removed",
        "status": false,
      }
    `);
  });

  it("404 unresolved route matches legacy envelope snapshot", async () => {
    const res = await request(app)
      .post("/api/auth/unknownPhase11Route")
      .set("Authorization", `Bearer ${bearerToken()}`)
      .send({});

    expect(res.status).toBe(404);
    assertLegacyEnvelopeShape(res.body);
    expect(pickLegacyEnvelope(res.body)).toMatchInlineSnapshot(`
      {
        "msg": "Route not found",
        "status": false,
      }
    `);
  });
});
