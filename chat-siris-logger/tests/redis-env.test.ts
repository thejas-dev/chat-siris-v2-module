import { afterEach, describe, expect, it } from "vitest";
import {
  buildBullMqConnection,
  isDualUrlMode,
  resolveCacheDbIndex,
  resolveCacheRedisUrl,
  resolveEventsDbIndex,
  resolveEventsRedisUrl,
} from "../src/redis-env";

const ENV_KEYS = [
  "REDIS_CACHE_URL",
  "REDIS_EVENTS_URL",
  "REDIS_URL",
  "REDIS_DB_CACHE",
  "REDIS_DB_EVENTS",
] as const;

function clearRedisEnv(): void {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
}

describe("redis-env", () => {
  afterEach(() => {
    clearRedisEnv();
  });

  it("falls back to local default when no env is set", () => {
    expect(resolveCacheRedisUrl()).toBe("redis://127.0.0.1:6379");
    expect(resolveEventsRedisUrl()).toBe("redis://127.0.0.1:6379");
  });

  it("prefers dual URLs over REDIS_URL", () => {
    process.env.REDIS_URL = "redis://legacy:6379";
    process.env.REDIS_CACHE_URL = "rediss://cache.upstash.io:6379";
    process.env.REDIS_EVENTS_URL = "rediss://events.upstash.io:6379";

    expect(resolveCacheRedisUrl()).toBe("rediss://cache.upstash.io:6379");
    expect(resolveEventsRedisUrl()).toBe("rediss://events.upstash.io:6379");
    expect(isDualUrlMode()).toBe(true);
  });

  it("uses db 0 for both clients when dual URLs are set", () => {
    process.env.REDIS_CACHE_URL = "rediss://cache.upstash.io:6379";
    process.env.REDIS_EVENTS_URL = "rediss://events.upstash.io:6379";
    process.env.REDIS_DB_CACHE = "2";
    process.env.REDIS_DB_EVENTS = "3";

    expect(resolveCacheDbIndex()).toBe(0);
    expect(resolveEventsDbIndex()).toBe(0);
  });

  it("uses REDIS_DB_* on single-host local fallback", () => {
    process.env.REDIS_URL = "redis://127.0.0.1:6379";
    process.env.REDIS_DB_CACHE = "0";
    process.env.REDIS_DB_EVENTS = "1";

    expect(resolveCacheDbIndex()).toBe(0);
    expect(resolveEventsDbIndex()).toBe(1);
  });

  it("buildBullMqConnection parses events URL with TLS and auth", () => {
    process.env.REDIS_EVENTS_URL =
      "rediss://default:secret%40token@events.example.com:6380";

    const conn = buildBullMqConnection();
    expect(conn.host).toBe("events.example.com");
    expect(conn.port).toBe(6380);
    expect(conn.db).toBe(0);
    expect(conn.password).toBe("secret@token");
    expect(conn.username).toBe("default");
    expect(conn.tls).toEqual({});
  });
});
