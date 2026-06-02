import type { AppRedis } from "../src/redis";

type CacheEntry = {
  value: string;
  expiresAt?: number;
};

export function createMemoryRedis(): AppRedis & {
  flushdb(): Promise<void>;
  publish(): Promise<number>;
} {
  const store = new Map<string, CacheEntry>();

  return {
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
      opts?: { EX?: number; ex?: number },
    ): Promise<string> {
      const ttl = opts?.EX ?? opts?.ex;
      const expiresAt =
        ttl !== undefined ? Date.now() + ttl * 1000 : undefined;
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

    async publish(): Promise<number> {
      return 1;
    },

    duplicate() {
      return this;
    },
  };
}

export function createMemoryEventsRedis(): {
  connect(): Promise<void>;
  publish(): Promise<number>;
  subscribe(): Promise<void>;
  quit(): Promise<void>;
  isOpen: boolean;
} {
  return {
    isOpen: true,
    async connect(): Promise<void> {},
    async publish(): Promise<number> {
      return 1;
    },
    async subscribe(): Promise<void> {},
    async quit(): Promise<void> {},
  };
}
