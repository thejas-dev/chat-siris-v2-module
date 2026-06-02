import type { AppRedis } from "../../src/redis";

type CacheEntry = {
  value: string;
  expiresAt?: number;
};

const loadedScripts = new Map<string, string>();

function incrementKey(
  store: Map<string, CacheEntry>,
  key: string,
  windowMs: number,
  resetOnChange: boolean,
): [number, number] {
  const now = Date.now();
  const entry = store.get(key);
  let timeToExpire = entry?.expiresAt ? entry.expiresAt - now : 0;

  if (!entry || timeToExpire <= 0) {
    store.set(key, { value: "1", expiresAt: now + windowMs });
    return [1, windowMs];
  }

  const totalHits = Number.parseInt(entry.value, 10) + 1;
  entry.value = String(totalHits);
  if (resetOnChange) {
    entry.expiresAt = now + windowMs;
    timeToExpire = windowMs;
  }

  return [totalHits, timeToExpire];
}

function getKeyStats(
  store: Map<string, CacheEntry>,
  key: string,
): [number | false, number] {
  const entry = store.get(key);
  const now = Date.now();
  if (!entry || (entry.expiresAt !== undefined && entry.expiresAt <= now)) {
    return [false, -1];
  }
  const totalHits = Number.parseInt(entry.value, 10);
  const timeToExpire =
    entry.expiresAt !== undefined ? Math.max(0, entry.expiresAt - now) : -1;
  return [totalHits, timeToExpire];
}

export function createMemoryRedis(): AppRedis & {
  flushdb(): Promise<void>;
  sendCommand(args: string[]): Promise<unknown>;
} {
  const store = new Map<string, CacheEntry>();

  function getEntry(key: string): CacheEntry | undefined {
    const entry = store.get(key);
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAt !== undefined && Date.now() > entry.expiresAt) {
      store.delete(key);
      return undefined;
    }
    return entry;
  }

  const client = {
    async get(key: string): Promise<string | null> {
      return getEntry(key)?.value ?? null;
    },

    async set(
      key: string,
      value: string,
      opts?: { EX?: number },
    ): Promise<string> {
      const expiresAt =
        opts?.EX !== undefined ? Date.now() + opts.EX * 1000 : undefined;
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
      const entry = getEntry(key);
      if (!entry) {
        return -2;
      }
      if (entry.expiresAt === undefined) {
        return -1;
      }
      return Math.max(0, Math.ceil((entry.expiresAt - Date.now()) / 1000));
    },

    async incr(key: string): Promise<number> {
      const entry = getEntry(key);
      const next = entry ? Number.parseInt(entry.value, 10) + 1 : 1;
      store.set(key, {
        value: String(next),
        expiresAt: entry?.expiresAt,
      });
      return next;
    },

    async expire(key: string, seconds: number): Promise<number> {
      const entry = store.get(key);
      if (!entry) {
        return 0;
      }
      entry.expiresAt = Date.now() + seconds * 1000;
      return 1;
    },

    async sendCommand(args: string[]): Promise<unknown> {
      const upper = args.map((a) => a.toUpperCase());
      const cmd = upper[0];

      if (cmd === "SCRIPT" && upper[1] === "LOAD") {
        const sha = `sha-${loadedScripts.size + 1}`;
        loadedScripts.set(sha, args[2] ?? "");
        return sha;
      }

      if (cmd === "EVALSHA") {
        const sha = args[1];
        const key = args[3];
        const resetOnChange = args[4] === "1";
        const windowMs = Number.parseInt(args[5] ?? "0", 10);

        if (loadedScripts.has(sha)) {
          const script = loadedScripts.get(sha) ?? "";
          if (script.includes("INCR")) {
            return incrementKey(store, key, windowMs, resetOnChange);
          }
          return getKeyStats(store, key);
        }
        return [0, -1];
      }

      switch (cmd) {
        case "GET":
          return getEntry(args[1]!)?.value ?? null;
        case "SET": {
          const key = args[1]!;
          const value = args[2] ?? "";
          let expiresAt: number | undefined;
          const pxIndex = upper.indexOf("PX");
          const exIndex = upper.indexOf("EX");
          if (pxIndex >= 0) {
            expiresAt = Date.now() + Number.parseInt(args[pxIndex + 1] ?? "0", 10);
          } else if (exIndex >= 0) {
            expiresAt =
              Date.now() + Number.parseInt(args[exIndex + 1] ?? "0", 10) * 1000;
          }
          store.set(key, { value, expiresAt });
          return "OK";
        }
        case "DEL":
          return client.del(args[1]!);
        case "INCR":
          return client.incr(args[1]!);
        case "EXPIRE":
          return client.expire(args[1]!, Number.parseInt(args[2] ?? "0", 10));
        case "TTL":
          return client.ttl(args[1]!);
        case "PTTL": {
          const entry = getEntry(args[1]!);
          if (!entry) {
            return -2;
          }
          if (entry.expiresAt === undefined) {
            return -1;
          }
          return Math.max(0, entry.expiresAt - Date.now());
        }
        case "PEXPIRE": {
          const entry = store.get(args[1]!);
          if (!entry) {
            return 0;
          }
          entry.expiresAt = Date.now() + Number.parseInt(args[2] ?? "0", 10);
          return 1;
        }
        case "PING":
          return "PONG";
        default:
          return null;
      }
    },

    async flushdb(): Promise<void> {
      store.clear();
    },
  };

  return client;
}
