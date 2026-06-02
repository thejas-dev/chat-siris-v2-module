type MemoryStore = Map<string, { value: string; expiresAt?: number }>;

export function createMemoryRedis() {
  const store: MemoryStore = new Map();

  return {
    isOpen: true,
    async connect(): Promise<void> {
      /* noop */
    },
    async quit(): Promise<void> {
      store.clear();
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
    async exists(key: string): Promise<number> {
      const entry = store.get(key);
      if (!entry) return 0;
      if (entry.expiresAt && entry.expiresAt < Date.now()) {
        store.delete(key);
        return 0;
      }
      return 1;
    },
    async del(key: string | string[]): Promise<number> {
      const keys = Array.isArray(key) ? key : [key];
      let n = 0;
      for (const k of keys) {
        if (store.delete(k)) n += 1;
      }
      return n;
    },
    async ping(): Promise<string> {
      return "PONG";
    },
  };
}
