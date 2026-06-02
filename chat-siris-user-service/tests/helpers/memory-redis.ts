import type Redis from "ioredis";

type CacheEntry = {
  value: string;
  expiresAt?: number;
};

export function createMemoryRedis(): Redis {
  const store = new Map<string, CacheEntry>();

  const client = {
    status: "ready" as const,

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
      expiryMode?: "EX" | "PX",
      ttl?: number,
    ): Promise<"OK"> {
      let expiresAt: number | undefined;
      if (expiryMode === "EX" && ttl !== undefined) {
        expiresAt = Date.now() + ttl * 1000;
      } else if (expiryMode === "PX" && ttl !== undefined) {
        expiresAt = Date.now() + ttl;
      }
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

    async flushdb(): Promise<void> {
      store.clear();
    },

    async connect(): Promise<void> {
      return;
    },

    async quit(): Promise<"OK"> {
      store.clear();
      return "OK";
    },
  };

  return client as unknown as Redis;
}
