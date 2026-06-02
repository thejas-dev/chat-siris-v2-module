import { EventEmitter } from "events";

type MemoryStore = Map<string, { value: string; expiresAt?: number }>;
type ChannelHandler = (message: string) => void;

export function createMemoryRedis() {
  const store: MemoryStore = new Map();
  const emitter = new EventEmitter();
  const channelHandlers = new Map<string, Set<ChannelHandler>>();

  const client = {
    isOpen: true,
    async connect(): Promise<void> {
      /* noop */
    },
    async quit(): Promise<void> {
      store.clear();
      channelHandlers.clear();
    },
    duplicate() {
      return createMemoryRedis();
    },
    async get(key: string): Promise<string | null> {
      const entry = store.get(key);
      if (!entry) return null;
      if (entry.expiresAt && entry.expiresAt < Date.now()) {
        store.delete(key);
        return null;
      }
      return entry.value;
    },
    async set(
      key: string,
      value: string,
      options?: { EX?: number; NX?: boolean },
    ): Promise<string | null> {
      if (options?.NX && store.has(key)) return null;
      store.set(key, {
        value,
        expiresAt: options?.EX ? Date.now() + options.EX * 1000 : undefined,
      });
      return "OK";
    },
    async del(key: string | string[]): Promise<number> {
      const keys = Array.isArray(key) ? key : [key];
      let removed = 0;
      for (const k of keys) {
        if (store.delete(k)) removed += 1;
      }
      return removed;
    },
    async exists(key: string): Promise<number> {
      return (await client.get(key)) !== null ? 1 : 0;
    },
    async incr(key: string): Promise<number> {
      const current = Number.parseInt((await client.get(key)) ?? "0", 10);
      const next = current + 1;
      await client.set(key, String(next));
      return next;
    },
    async expire(key: string, seconds: number): Promise<number> {
      const entry = store.get(key);
      if (!entry) return 0;
      entry.expiresAt = Date.now() + seconds * 1000;
      return 1;
    },
    async ping(): Promise<string> {
      return "PONG";
    },
    async publish(channel: string, message: string): Promise<number> {
      const handlers = channelHandlers.get(channel);
      if (!handlers || handlers.size === 0) {
        return 0;
      }
      for (const handler of handlers) {
        handler(message);
      }
      return handlers.size;
    },
    async subscribe(channel: string, handler: ChannelHandler): Promise<void> {
      let handlers = channelHandlers.get(channel);
      if (!handlers) {
        handlers = new Set();
        channelHandlers.set(channel, handlers);
      }
      handlers.add(handler);
    },
    async unsubscribe(...channels: string[]): Promise<void> {
      for (const ch of channels) {
        channelHandlers.delete(ch);
      }
    },
    on(event: string, listener: (...args: unknown[]) => void): void {
      emitter.on(event, listener);
    },
    async *scanIterator(options: {
      MATCH: string;
      COUNT: number;
    }): AsyncIterable<string> {
      const pattern = options.MATCH.replace(/\*/g, ".*");
      const regex = new RegExp(`^${pattern}$`);
      for (const key of store.keys()) {
        if (regex.test(key)) {
          yield key;
        }
      }
    },
  };

  return client;
}
