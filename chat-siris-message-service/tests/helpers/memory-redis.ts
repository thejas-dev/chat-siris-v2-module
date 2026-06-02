import type { AppRedis } from "../src/redis";

type CacheEntry = {
  value: string;
  expiresAt?: number;
};

export function createMemoryRedis(): AppRedis & {
  flushdb(): Promise<void>;
  publish(channel: string, message: string): Promise<number>;
  getPublished(): Array<{ channel: string; message: string }>;
} {
  const store = new Map<string, CacheEntry>();
  const published: Array<{ channel: string; message: string }> = [];

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

    async publish(channel: string, message: string): Promise<number> {
      published.push({ channel, message });
      return 1;
    },

    getPublished(): Array<{ channel: string; message: string }> {
      return [...published];
    },

    async sendCommand(args: string[]): Promise<unknown> {
      const [command, key, ...rest] = args;
      if (command?.toUpperCase() === "GET") {
        return this.get(String(key));
      }
      if (command?.toUpperCase() === "SET") {
        const value = rest[0];
        const exIndex = rest.findIndex((part) => part.toUpperCase() === "EX");
        const ttl =
          exIndex >= 0 ? Number.parseInt(String(rest[exIndex + 1]), 10) : undefined;
        await this.set(String(key), String(value), ttl ? { EX: ttl } : undefined);
        return "OK";
      }
      if (command?.toUpperCase() === "DEL") {
        return this.del(String(key));
      }
      if (command?.toUpperCase() === "PING") {
        return "PONG";
      }
      if (command?.toUpperCase() === "INCR") {
        const current = await this.get(String(key));
        const next = (Number.parseInt(current ?? "0", 10) || 0) + 1;
        await this.set(String(key), String(next));
        return next;
      }
      if (command?.toUpperCase() === "EXPIRE") {
        return 1;
      }
      if (command?.toUpperCase() === "PTTL") {
        return 60000;
      }
      return null;
    },

    duplicate() {
      return this;
    },
  };
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
