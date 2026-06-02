export type JwtCacheValue = {
  userId: string;
  email: string;
  jti: string;
  roles: string[];
  exp: number;
};

export const JWT_CACHE_PREFIX = "chat:jwt:";
export const JWT_CACHE_TTL_SEC = 840;

export type IntrospectResult = {
  active: boolean;
  sub?: string;
  email?: string;
  jti?: string;
  exp?: number;
};

let introspectCallCount = 0;

export function getIntrospectCallCount(): number {
  return introspectCallCount;
}

export function resetIntrospectCallCount(): void {
  introspectCallCount = 0;
}

function cacheKey(jti: string): string {
  return `${JWT_CACHE_PREFIX}${jti}`;
}

function ttlFromExp(exp: number): number {
  const remaining = exp - Math.floor(Date.now() / 1000);
  return Math.min(JWT_CACHE_TTL_SEC, Math.max(1, remaining));
}

export async function getCachedJwtClaims(
  jti: string,
): Promise<JwtCacheValue | null> {
  try {
    const { getRedis } = await import("../redis");
    const redis = await getRedis();
    const raw = await redis.get(cacheKey(jti));
    if (!raw) {
      return null;
    }
    return JSON.parse(raw) as JwtCacheValue;
  } catch {
    return null;
  }
}

export async function setCachedJwtClaims(
  jti: string,
  value: JwtCacheValue,
  exp: number,
): Promise<void> {
  try {
    const { getRedis } = await import("../redis");
    const redis = await getRedis();
    await redis.set(cacheKey(jti), JSON.stringify(value), {
      EX: ttlFromExp(exp),
    });
  } catch {
    // Cache write failure is non-fatal; introspect already validated token.
  }
}

export async function introspectToken(
  token: string,
): Promise<IntrospectResult> {
  const authServiceUrl =
    process.env.AUTH_SERVICE_URL ?? "http://localhost:3001";
  const secret = process.env.INTERNAL_HMAC_SECRET;
  if (!secret) {
    throw new Error("INTERNAL_HMAC_SECRET is required");
  }

  const path = "/internal/token/introspect";
  const { signInternalRequest } = await import("@chat-siris/logger");
  const { signature, timestamp } = signInternalRequest("POST", path, secret);

  introspectCallCount += 1;

  const response = await fetch(`${authServiceUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Signature": signature,
      "X-Internal-Timestamp": String(timestamp),
    },
    body: JSON.stringify({ token }),
  });

  if (response.status === 401) {
    return { active: false };
  }

  if (!response.ok) {
    return { active: false };
  }

  return (await response.json()) as IntrospectResult;
}

export async function resolveAuthClaims(
  token: string,
): Promise<JwtCacheValue | null> {
  const jwt = await import("jsonwebtoken");
  const decoded = jwt.decode(token) as { jti?: string } | null;
  const jti = decoded?.jti;

  if (jti) {
    const cached = await getCachedJwtClaims(jti);
    if (cached && cached.exp > Math.floor(Date.now() / 1000)) {
      return cached;
    }
  }

  let cacheDegraded = false;
  if (jti) {
    try {
      const { getRedis } = await import("../redis");
      await getRedis();
    } catch {
      cacheDegraded = true;
    }
  }

  const result = await introspectToken(token);
  if (!result.active || !result.sub || !result.email || !result.jti || !result.exp) {
    return null;
  }

  const claims: JwtCacheValue = {
    userId: result.sub,
    email: result.email,
    jti: result.jti,
    roles: ["user"],
    exp: result.exp,
  };

  if (cacheDegraded) {
    const { createLogger } = await import("@chat-siris/logger");
    createLogger(process.env.SERVICE_NAME ?? "api-gateway").warn(
      "jwt_cache_degraded",
      { jti: result.jti },
    );
  } else {
    await setCachedJwtClaims(result.jti, claims, result.exp);
  }

  return claims;
}

export async function getJwtCacheTtl(jti: string): Promise<number> {
  try {
    const { getRedis } = await import("../redis");
    const redis = await getRedis();
    return redis.ttl(cacheKey(jti));
  } catch {
    return -2;
  }
}
