const LOCAL_DEFAULT = "redis://127.0.0.1:6379";

export function resolveCacheRedisUrl(): string {
  return (
    process.env.REDIS_CACHE_URL?.trim() ||
    process.env.REDIS_URL?.trim() ||
    LOCAL_DEFAULT
  );
}

export function resolveEventsRedisUrl(): string {
  return (
    process.env.REDIS_EVENTS_URL?.trim() ||
    process.env.REDIS_URL?.trim() ||
    LOCAL_DEFAULT
  );
}

/** DB index for cache client. Upstash dual-URL mode → always 0. */
export function resolveCacheDbIndex(): number {
  if (process.env.REDIS_CACHE_URL?.trim()) return 0;
  return Number.parseInt(process.env.REDIS_DB_CACHE ?? "0", 10);
}

/** DB index for events client. Upstash dual-URL mode → always 0. */
export function resolveEventsDbIndex(): number {
  if (process.env.REDIS_EVENTS_URL?.trim()) return 0;
  return Number.parseInt(process.env.REDIS_DB_EVENTS ?? "1", 10);
}

export function isDualUrlMode(): boolean {
  return Boolean(
    process.env.REDIS_CACHE_URL?.trim() && process.env.REDIS_EVENTS_URL?.trim(),
  );
}

export type BullMqConnection = {
  host: string;
  port: number;
  db: number;
  password?: string;
  username?: string;
  tls?: Record<string, never>;
};

/** BullMQ/ioredis connection options parsed from the events Redis URL. */
export function buildBullMqConnection(): BullMqConnection {
  const url = resolveEventsRedisUrl();
  const parsed = new URL(url);
  const connection: BullMqConnection = {
    host: parsed.hostname,
    port: Number.parseInt(parsed.port || "6379", 10),
    db: resolveEventsDbIndex(),
  };
  if (parsed.password) {
    connection.password = decodeURIComponent(parsed.password);
  }
  if (parsed.username) {
    connection.username = decodeURIComponent(parsed.username);
  }
  if (parsed.protocol === "rediss:") {
    connection.tls = {};
  }
  return connection;
}
