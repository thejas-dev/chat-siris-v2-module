import type { AppRedis } from "../src/redis";

type CacheEntry = {
  value: string;
  expiresAt?: number;
};

const incrementScript = `
local windowMs = tonumber(ARGV[2])
local resetOnChange = ARGV[1] == "1"
local timeToExpire = redis.call("PTTL", KEYS[1])
if timeToExpire <= 0 then
  redis.call("SET", KEYS[1], 1, "PX", windowMs)
  return { 1, windowMs }
end
local totalHits = redis.call("INCR", KEYS[1])
if resetOnChange then
  redis.call("PEXPIRE", KEYS[1], windowMs)
  timeToExpire = windowMs
end
return { totalHits, timeToExpire }
`.trim();

const getScript = `
local totalHits = redis.call("GET", KEYS[1])
local timeToExpire = redis.call("PTTL", KEYS[1])
return { totalHits, timeToExpire }
`.trim();

function scriptSha(script: string): string {
  let hash = 0;
  for (let i = 0; i < script.length; i += 1) {
    hash = (hash * 31 + script.charCodeAt(i)) >>> 0;
  }
  return `mocksha_${hash.toString(16)}`;
}

export function createMemoryRedis(): AppRedis & {
  flushdb(): Promise<void>;
  getPublished(): Array<{ channel: string; message: string }>;
} {
  const store = new Map<string, CacheEntry>();
  const loadedScripts = new Map<string, string>([
    [scriptSha(incrementScript), incrementScript],
    [scriptSha(getScript), getScript],
  ]);

  const redisApi = {
    async get(key: string): Promise<string | null> {
      const entry = store.get(key);
      if (!entry) {
        return null;
      }
      if (entry.expiresAt !== undefined && Date.now() > entry.expiresAt) {
        store.delete(key);
        return null;
      }
      return entry.value;
    },

    async set(
      key: string,
      value: string,
      opts?: { EX?: number; ex?: number; PX?: number; px?: number },
    ): Promise<string> {
      const ttlSeconds = opts?.EX ?? opts?.ex;
      const ttlMs = opts?.PX ?? opts?.px;
      const expiresAt =
        ttlMs !== undefined
          ? Date.now() + ttlMs
          : ttlSeconds !== undefined
            ? Date.now() + ttlSeconds * 1000
            : undefined;
      store.set(key, { value, expiresAt });
      return "OK";
    },

    async del(...keys: string[]): Promise<number> {
      let removed = 0;
      for (const key of keys) {
        if (store.delete(key)) {
          removed++;
        }
      }
      return removed;
    },

    async ping(): Promise<string> {
      return "PONG";
    },

    async ttl(key: string): Promise<number> {
      const entry = store.get(key);
      if (!entry) {
        return -2;
      }
      if (entry.expiresAt === undefined) {
        return -1;
      }
      return Math.max(0, Math.ceil((entry.expiresAt - Date.now()) / 1000));
    },

    async pttl(key: string): Promise<number> {
      const entry = store.get(key);
      if (!entry) {
        return -2;
      }
      if (entry.expiresAt === undefined) {
        return -1;
      }
      return Math.max(0, entry.expiresAt - Date.now());
    },

    async incr(key: string): Promise<number> {
      const entry = store.get(key);
      const current = entry ? Number.parseInt(entry.value, 10) || 0 : 0;
      const next = current + 1;
      store.set(key, { value: String(next), expiresAt: entry?.expiresAt });
      return next;
    },

    async flushdb(): Promise<void> {
      store.clear();
    },

    getPublished(): Array<{ channel: string; message: string }> {
      return [];
    },

    async sendCommand(args: string[]): Promise<unknown> {
      const [command, ...rest] = args;
      const cmd = command?.toUpperCase();

      if (cmd === "GET") {
        return redisApi.get(String(rest[0]));
      }
      if (cmd === "SET") {
        const key = String(rest[0]);
        const value = rest[1];
        const exIndex = rest.findIndex((part) => part.toUpperCase() === "EX");
        const pxIndex = rest.findIndex((part) => part.toUpperCase() === "PX");
        const ttl =
          exIndex >= 0 ? Number.parseInt(String(rest[exIndex + 1]), 10) : undefined;
        const px =
          pxIndex >= 0 ? Number.parseInt(String(rest[pxIndex + 1]), 10) : undefined;
        await redisApi.set(String(key), String(value), { EX: ttl, PX: px });
        return "OK";
      }
      if (cmd === "DEL") {
        return redisApi.del(String(rest[0]));
      }
      if (cmd === "PING") {
        return "PONG";
      }
      if (cmd === "INCR") {
        return redisApi.incr(String(rest[0]));
      }
      if (cmd === "EXPIRE" || cmd === "PEXPIRE") {
        const key = String(rest[0]);
        const ttlArg = rest[1];
        const entry = store.get(key);
        if (!entry) {
          return 0;
        }
        const ttlNum = Number.parseInt(String(ttlArg), 10);
        entry.expiresAt =
          cmd === "PEXPIRE" ? Date.now() + ttlNum : Date.now() + ttlNum * 1000;
        store.set(key, entry);
        return 1;
      }
      if (cmd === "PTTL") {
        return redisApi.pttl(String(rest[0]));
      }
      if (cmd === "TTL") {
        return redisApi.ttl(String(rest[0]));
      }
      if (cmd === "SCRIPT" && rest[0]?.toUpperCase() === "LOAD") {
        const script = rest[1] ?? rest.slice(1).join(" ");
        const sha = scriptSha(String(script));
        loadedScripts.set(sha, String(script));
        return sha;
      }
      if (cmd === "EVALSHA") {
        const sha = String(rest[0]);
        const key = String(rest[2]);
        const resetOnChange = rest[3] === "1";
        const windowMs = Number.parseInt(String(rest[4]), 10);
        const script = loadedScripts.get(sha) ?? "";

        if (script.includes("INCR")) {
          const timeToExpire = await redisApi.pttl(key);
          if (timeToExpire <= 0) {
            await redisApi.set(key, "1", { PX: windowMs });
            return [1, windowMs];
          }
          const totalHits = await redisApi.incr(key);
          if (resetOnChange) {
            await redisApi.sendCommand(["PEXPIRE", key, String(windowMs)]);
            return [totalHits, windowMs];
          }
          return [totalHits, await redisApi.pttl(key)];
        }

        const totalHits = await redisApi.get(key);
        return [totalHits ?? false, await redisApi.pttl(key)];
      }
      return null;
    },

    duplicate() {
      return redisApi;
    },
  };

  return redisApi;
}

export function createMemoryEventsRedis(): {
  connect(): Promise<void>;
  publish(channel: string, message: string): Promise<number>;
  subscribe(): Promise<void>;
  quit(): Promise<void>;
  isOpen: boolean;
  getPublished(): Array<{ channel: string; message: string }>;
} {
  const published: Array<{ channel: string; message: string }> = [];
  return {
    isOpen: true,
    async connect(): Promise<void> {},
    async publish(channel: string, message: string): Promise<number> {
      published.push({ channel, message });
      return 1;
    },
    async subscribe(): Promise<void> {},
    async quit(): Promise<void> {},
    getPublished(): Array<{ channel: string; message: string }> {
      return [...published];
    },
  };
}
