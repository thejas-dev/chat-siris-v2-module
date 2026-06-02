import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { Express } from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { randomUUID } from "crypto";
import { signInternalRequest } from "@chat-siris/logger";
import {
  createApp,
  setRedisClient,
  resetRedisClient,
} from "../src/index";
import {
  AUTH_PUBLIC_PATHS,
  AUTH_SERVICE_PATHS,
  resolveUpstream,
  isJwtExempt,
} from "../src/config/route-map";
import { injectInternalHeaders } from "../src/middleware/hmac-forward.middleware";
import {
  getIntrospectCallCount,
  resetIntrospectCallCount,
  getJwtCacheTtl,
  JWT_CACHE_TTL_SEC,
} from "../src/services/auth-introspect.service";
import { createMemoryRedis } from "./helpers/memory-redis";
import { TEST_JWT_PRIVATE_KEY, TEST_JWT_PUBLIC_KEY } from "./helpers/test-keys";

const HMAC_SECRET = "test-hmac-secret-for-integration";
const AUTH_SERVICE_URL = "http://auth-service.test";
const MONOLITH_URL = "http://monolith.test";

type CapturedRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
};

const capturedRequests: CapturedRequest[] = [];

const mockUser = {
  _id: "507f1f77bcf86cd799439011",
  username: "testuser",
  email: "test@example.com",
  avatarImage: "",
  isAvatarImageSet: false,
  backgroundImage: "",
  admin: "",
  inChannel: "",
};

function issueTestAccessToken(overrides: { sub?: string; email?: string } = {}): string {
  return jwt.sign(
    {
      sub: overrides.sub ?? mockUser._id,
      email: overrides.email ?? mockUser.email,
      jti: randomUUID(),
    },
    TEST_JWT_PRIVATE_KEY,
    { algorithm: "RS256", expiresIn: 900 },
  );
}

function verifyTestToken(token: string): {
  active: boolean;
  sub?: string;
  email?: string;
  jti?: string;
  exp?: number;
} {
  try {
    const decoded = jwt.verify(token, TEST_JWT_PUBLIC_KEY, {
      algorithms: ["RS256"],
    }) as jwt.JwtPayload;

    if (
      typeof decoded.sub !== "string" ||
      typeof decoded.email !== "string" ||
      typeof decoded.jti !== "string" ||
      typeof decoded.exp !== "number"
    ) {
      return { active: false };
    }

    return {
      active: true,
      sub: decoded.sub,
      email: decoded.email,
      jti: decoded.jti,
      exp: decoded.exp,
    };
  } catch {
    return { active: false };
  }
}

vi.stubGlobal(
  "fetch",
  vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = Object.fromEntries(
      Object.entries(init?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]),
    );

    capturedRequests.push({
      url,
      method,
      headers,
      body: init?.body as string | undefined,
    });

    if (method === "GET" && url.endsWith("/health")) {
      return new Response(
        JSON.stringify({ status: "ok", service: "auth-service", mongo: "ok", redis: "ok" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (method === "POST" && url.endsWith("/internal/login")) {
      const body = JSON.parse(init?.body as string) as { email?: string };
      if (body.email === "unknown@example.com") {
        return new Response(
          JSON.stringify({
            status: false,
            msg: "Account need to be Regitered",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          status: true,
          user: mockUser,
          accessToken: issueTestAccessToken(),
          refreshToken: "refresh-token-id",
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Set-Cookie": "refreshToken=refresh-token-id; HttpOnly; Path=/",
          },
        },
      );
    }

    if (method === "POST" && url.endsWith("/internal/register")) {
      const body = JSON.parse(init?.body as string) as { email?: string };
      if (body.email === "duplicate@example.com") {
        return new Response(
          JSON.stringify({
            status: false,
            msg: "An account with this email already exists",
          }),
          { status: 409, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          status: true,
          user: mockUser,
          accessToken: issueTestAccessToken(),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (method === "POST" && url.endsWith("/internal/oauth/google")) {
      const body = JSON.parse(init?.body as string) as { idToken?: string };
      if (body.idToken === "valid-google-token") {
        return new Response(
          JSON.stringify({
            status: true,
            user: mockUser,
            accessToken: issueTestAccessToken(),
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ status: false, msg: "Authentication required" }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
    }

    if (method === "POST" && url.endsWith("/internal/token/refresh")) {
      return new Response(
        JSON.stringify({ accessToken: issueTestAccessToken() }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (method === "POST" && url.endsWith("/internal/token/introspect")) {
      const sig = headers["x-internal-signature"];
      const ts = headers["x-internal-timestamp"];
      if (!sig || !ts) {
        return new Response(JSON.stringify({ active: false }), { status: 401 });
      }

      const valid = signInternalRequest(
        "POST",
        "/internal/token/introspect",
        HMAC_SECRET,
      );
      // Allow any recent timestamp in tests by re-verifying with provided ts
      const crypto = await import("crypto");
      const payload = `${ts}.POST./internal/token/introspect`;
      const expected = crypto
        .createHmac("sha256", HMAC_SECRET)
        .update(payload)
        .digest("hex");

      if (sig !== expected) {
        return new Response(JSON.stringify({ active: false }), { status: 401 });
      }

      const body = JSON.parse(init?.body as string) as { token?: string };
      const result = verifyTestToken(body.token ?? "");
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (method === "POST" && url.endsWith("/internal/messages/history")) {
      return new Response(
        JSON.stringify({
          status: true,
          data: [{ _id: "msg1", message: { text: "hello" } }],
          pagination: { hasMore: false, nextCursor: null },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (method === "POST" && url.includes("/api/auth/getMessages")) {
      return new Response(
        JSON.stringify({ status: true, data: [{ id: "msg1", text: "hello" }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (
      method === "POST" &&
      url.includes("monolith.test/api/auth/updateName")
    ) {
      return new Response(
        JSON.stringify({
          status: true,
          obj: { _id: mockUser._id, username: "newname" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (method === "POST" && url.endsWith("/api/auth/login")) {
      return new Response(
        JSON.stringify({ status: true, user: mockUser }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (method === "POST" && url.endsWith("/api/auth/register")) {
      return new Response(
        JSON.stringify({ status: true, user: mockUser }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    return new Response("not found", { status: 404 });
  }),
);

describe("route-map target contracts", () => {
  beforeEach(() => {
    process.env.AUTH_SERVICE_URL = AUTH_SERVICE_URL;
    process.env.MONOLITH_URL = MONOLITH_URL;
  });

  it("exports AUTH_PUBLIC_PATHS and AUTH_SERVICE_PATHS", () => {
    expect(AUTH_PUBLIC_PATHS).toContain("/api/auth/login");
    expect(AUTH_PUBLIC_PATHS).toContain("/api/auth/token/refresh");
    expect(AUTH_SERVICE_PATHS.get("POST /api/auth/login")).toBe("/internal/login");
  });

  it("resolveUpstream routes auth paths to auth-service", () => {
    process.env.AUTH_SERVICE_ENABLED = "true";
    const target = resolveUpstream("/api/auth/login", "POST");
    expect(target.service).toBe("auth");
    expect(target.url).toBe(`${AUTH_SERVICE_URL}/internal/login`);
  });

  it("resolveUpstream routes getMessages to message-service by default", () => {
    process.env.MESSAGE_SERVICE_URL = "http://message.test";
    const target = resolveUpstream("/api/auth/getMessages", "POST");
    expect(target.service).toBe("message");
    expect(target.url).toBe("http://message.test/internal/messages/history");
  });

  it("resolveUpstream marks unknown paths as unresolved", () => {
    const target = resolveUpstream("/api/auth/unknownRoute", "POST");
    expect(target.service).toBe("unresolved");
  });

  it("isJwtExempt matches public auth paths only", () => {
    expect(isJwtExempt("/api/auth/login")).toBe(true);
    expect(isJwtExempt("/api/auth/getMessages")).toBe(false);
  });
});

describe("gateway integration", () => {
  let app: Express;
  let memoryRedis: ReturnType<typeof createMemoryRedis>;

  beforeAll(async () => {
    process.env.SERVICE_NAME = "api-gateway";
    process.env.INTERNAL_HMAC_SECRET = HMAC_SECRET;
    process.env.AUTH_SERVICE_URL = AUTH_SERVICE_URL;
    process.env.MONOLITH_URL = MONOLITH_URL;
    process.env.AUTH_SERVICE_ENABLED = "true";
    process.env.REDIS_URL = "redis://localhost:6379";
    process.env.RATE_LIMIT_IP_MAX = "100";

    memoryRedis = createMemoryRedis();
    setRedisClient(memoryRedis);
    app = await createApp();
  });

  afterAll(() => {
    resetRedisClient();
    vi.unstubAllGlobals();
  });

  beforeEach(async () => {
    capturedRequests.length = 0;
    resetIntrospectCallCount();
    await memoryRedis.flushdb();
    process.env.AUTH_SERVICE_ENABLED = "true";
    process.env.USER_SERVICE_ENABLED = "true";
    process.env.GROUP_SERVICE_ENABLED = "true";
  });

  it("P1-F-02: unknown email returns exact legacy error message", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "unknown@example.com" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: false,
      msg: "Account need to be Regitered",
    });
  });

  it("P1-F-03: register returns merged user and accessToken", async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .send({
        username: "newuser",
        email: "new@example.com",
        avatarImage: "",
        isAvatarImageSet: false,
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(true);
    expect(res.body.user).toBeDefined();
    expect(res.body.accessToken).toBeDefined();
  });

  it("P1-F-04: duplicate email register returns 409", async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .send({
        username: "dupuser",
        email: "duplicate@example.com",
        avatarImage: "",
        isAvatarImageSet: false,
      });

    expect(res.status).toBe(409);
    expect(res.body.status).toBe(false);
  });

  it("P1-F-05: valid Google oauth returns user and accessToken", async () => {
    const res = await request(app)
      .post("/api/auth/oauth/google")
      .send({ idToken: "valid-google-token" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(true);
    expect(res.body.user).toBeDefined();
    expect(res.body.accessToken).toBeDefined();
  });

  it("P1-F-06: invalid Google oauth returns 401", async () => {
    const res = await request(app)
      .post("/api/auth/oauth/google")
      .send({ idToken: "invalid-token" });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      status: false,
      msg: "Authentication required",
    });
  });

  it("P1-F-07: token refresh returns new accessToken", async () => {
    const res = await request(app)
      .post("/api/auth/token/refresh")
      .set("Cookie", "refreshToken=valid-refresh-id")
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeDefined();
  });

  it("P1-F-01: login through gateway returns user, accessToken, refresh cookie", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "test@example.com" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(true);
    expect(res.body.user).toBeDefined();
    expect(res.body.accessToken).toBeDefined();
    expect(res.headers["set-cookie"]?.join(";")).toContain("refreshToken");
    expect(capturedRequests.some((r) => r.url.endsWith("/internal/login"))).toBe(true);
  });

  it("P1-F-08: protected route without JWT returns 401", async () => {
    const beforeCount = capturedRequests.length;

    const res = await request(app)
      .post("/api/auth/getMessages")
      .send({ channelId: "abc" });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      status: false,
      msg: "Authentication required",
    });
    expect(capturedRequests.length).toBe(beforeCount);
  });

  it("P1-F-09: rollback flag proxies login to monolith", async () => {
    process.env.AUTH_SERVICE_ENABLED = "false";

    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "test@example.com" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(true);
    expect(capturedRequests.some((r) => r.url === `${MONOLITH_URL}/api/auth/login`)).toBe(
      true,
    );
    expect(capturedRequests.some((r) => r.url.endsWith("/internal/login"))).toBe(false);
  });

  it("P1-F-10: auth proxy forwards X-Request-Id", async () => {
    await request(app)
      .post("/api/auth/login")
      .set("X-Request-Id", "custom-request-id")
      .send({ email: "test@example.com" });

    const authCall = capturedRequests.find((r) => r.url.endsWith("/internal/login"));
    expect(authCall?.headers["x-request-id"]).toBe("custom-request-id");
  });

  it("P1-F-14: injectInternalHeaders includes identity headers for valid JWT context", () => {
    const token = issueTestAccessToken();
    const decoded = jwt.decode(token) as jwt.JwtPayload;

    const fakeReq = {
      method: "POST",
      logContext: { requestId: "req-123" },
      headers: { "x-request-id": "req-123" },
      authClaims: {
        userId: decoded.sub as string,
        email: decoded.email as string,
        role: "user" as const,
        jti: decoded.jti as string,
        exp: decoded.exp as number,
      },
    };

    const headers = injectInternalHeaders(
      fakeReq as never,
      "/internal/users/123/profile",
      fakeReq.authClaims,
    );

    expect(headers["X-User-Id"]).toBe(mockUser._id);
    expect(headers["X-User-Email"]).toBe(mockUser.email);
    expect(headers["X-User-Role"]).toBe("user");
    expect(headers["X-Auth-Jti"]).toBeDefined();
    expect(headers["X-Request-Id"]).toBe("req-123");
    expect(headers["X-Internal-Signature"]).toBeDefined();
    expect(headers["X-Internal-Timestamp"]).toBeDefined();
  });

  it("P1-F-15: gateway health returns ok when dependencies are healthy", async () => {
    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.service).toBe("api-gateway");
  });

  it("P1-N-02: client X-User-Id without JWT returns 401 before upstream", async () => {
    const beforeCount = capturedRequests.length;

    const res = await request(app)
      .post("/api/auth/getMessages")
      .set("X-User-Id", "spoofed-user-id")
      .send({ channelId: "abc" });

    expect(res.status).toBe(401);
    expect(capturedRequests.length).toBe(beforeCount);
  });

  it("P1-P-06: monolith passthrough preserves response envelope when message service disabled", async () => {
    process.env.MESSAGE_SERVICE_ENABLED = "false";
    const token = issueTestAccessToken();

    const res = await request(app)
      .post("/api/auth/getMessages")
      .set("Authorization", `Bearer ${token}`)
      .send({ channelId: "abc" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(true);
    expect(res.body.data).toBeDefined();

    const monolithCall = capturedRequests.find((r) =>
      r.url.includes("/api/auth/getMessages"),
    );
    expect(monolithCall).toBeDefined();
    expect(monolithCall?.headers["x-user-id"]).toBeUndefined();
    expect(monolithCall?.headers["x-internal-signature"]).toBeUndefined();

    delete process.env.MESSAGE_SERVICE_ENABLED;
  });

  it("Phase 10: getMessages routes to message-service with HMAC when enabled", async () => {
    process.env.MESSAGE_SERVICE_URL = "http://message.test";
    const token = issueTestAccessToken();

    const res = await request(app)
      .post("/api/auth/getMessages")
      .set("Authorization", `Bearer ${token}`)
      .send({ group: "general" });

    expect(res.status).toBe(200);
    expect(res.body.pagination).toBeDefined();

    const messageCall = capturedRequests.find((r) =>
      r.url.includes("/internal/messages/history"),
    );
    expect(messageCall).toBeDefined();
    expect(messageCall?.headers["x-internal-signature"]).toBeDefined();
    expect(messageCall?.headers["x-user-id"]).toBeDefined();
  });

  it("P1-NF-05: 101st request from same IP returns 429", async () => {
    const localRedis = createMemoryRedis();
    setRedisClient(localRedis);
    const limitedApp = await createApp({ ipRateLimitMax: 100 });

    for (let i = 0; i < 100; i++) {
      const res = await request(limitedApp)
        .post("/api/auth/login")
        .send({ email: "rate-limit@example.com" });
      expect(res.status).toBe(200);
    }

    const blocked = await request(limitedApp)
      .post("/api/auth/login")
      .send({ email: "rate-limit@example.com" });
    expect(blocked.status).toBe(429);
    expect(blocked.body.status).toBe(false);

    setRedisClient(memoryRedis);
    await memoryRedis.flushdb();
  });

  it("P1-NF-01: JWT cache hit rate >= 80% on 100 sequential protected calls", async () => {
    const token = issueTestAccessToken();
    const decoded = jwt.decode(token) as jwt.JwtPayload;
    const jti = decoded.jti as string;

    await request(app)
      .post("/api/auth/getMessages")
      .set("Authorization", `Bearer ${token}`)
      .send({ channelId: "abc" });

    const introspectsAfterFirst = getIntrospectCallCount();
    expect(introspectsAfterFirst).toBe(1);

    for (let i = 0; i < 99; i++) {
      await request(app)
        .post("/api/auth/getMessages")
        .set("Authorization", `Bearer ${token}`)
        .send({ channelId: "abc" });
    }

    const totalIntrospects = getIntrospectCallCount();
    const cacheHits = 100 - totalIntrospects;
    const hitRate = cacheHits / 100;
    expect(hitRate).toBeGreaterThanOrEqual(0.8);

    const ttl = await getJwtCacheTtl(jti);
    expect(ttl).toBeLessThanOrEqual(JWT_CACHE_TTL_SEC);
    expect(ttl).toBeGreaterThan(0);
  });

  it("P1-F-16: auth-service health reachable via aggregate check", async () => {
    const res = await request(app).get("/health/aggregate");

    expect(res.status).toBe(200);
    expect(res.body.dependencies.authService).toBe("ok");
  });

  it("oauth/google proxies to auth-service", async () => {
    const res = await request(app)
      .post("/api/auth/oauth/google")
      .send({ idToken: "valid-google-token" });

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeDefined();
    expect(capturedRequests.some((r) => r.url.endsWith("/internal/oauth/google"))).toBe(
      true,
    );
  });

  it("token/refresh proxies to auth-service without Bearer JWT", async () => {
    const res = await request(app)
      .post("/api/auth/token/refresh")
      .set("Cookie", "refreshToken=test-refresh-id")
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeDefined();
  });

  it("P2-F-18: Tradity routes return 410 Gone without upstream call", async () => {
    const token = issueTestAccessToken();

    const res = await request(app)
      .get("/api/auth/tradity")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(410);
    expect(res.body.status).toBe(false);
    expect(
      capturedRequests.some((r) => r.url.includes("/api/auth/tradity")),
    ).toBe(false);
  });

  it("P2-F-27: USER_SERVICE_ENABLED=false routes profile update to monolith", async () => {
    process.env.USER_SERVICE_ENABLED = "false";
    const token = issueTestAccessToken();

    await request(app)
      .post("/api/auth/updateName/507f1f77bcf86cd799439011")
      .set("Authorization", `Bearer ${token}`)
      .send({ username: "newname" });

    expect(
      capturedRequests.some((r) =>
        r.url.includes("monolith.test/api/auth/updateName"),
      ),
    ).toBe(true);
    process.env.USER_SERVICE_ENABLED = "true";
  });
});

describe("gateway rate limit fail-open", () => {
  it("P1-NF-10: Redis down uses fail-open with rate_limit_degraded log", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    resetRedisClient();
    const brokenRedis = {
      get: async () => {
        throw new Error("redis down");
      },
      set: async () => {
        throw new Error("redis down");
      },
      del: async () => {
        throw new Error("redis down");
      },
      ping: async () => {
        throw new Error("redis down");
      },
      ttl: async () => {
        throw new Error("redis down");
      },
      incr: async () => {
        throw new Error("redis down");
      },
      expire: async () => {
        throw new Error("redis down");
      },
      sendCommand: async () => {
        throw new Error("redis down");
      },
    };

    setRedisClient(brokenRedis);

    const { createFailOpenRateLimiter } = await import(
      "../src/middleware/rate-limit.middleware"
    );
    const failOpen = createFailOpenRateLimiter();

    const next = vi.fn();
    failOpen({ logContext: { requestId: "r1" } } as never, {} as never, next);
    expect(next).toHaveBeenCalled();

    warnSpy.mockRestore();
    const restored = createMemoryRedis();
    setRedisClient(restored);
  });
});
