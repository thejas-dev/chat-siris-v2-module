import crypto from "crypto";

const TIMESTAMP_TOLERANCE_SEC = process.env.TIMESTAMP_TOLERANCE_SEC ? Number.parseInt(process.env.TIMESTAMP_TOLERANCE_SEC, 10) : 60;

export interface InternalRequestLike {
  method: string;
  path?: string;
  originalUrl?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
}

function getHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function resolvePath(req: InternalRequestLike): string {
  if (req.path) {
    return req.path;
  }
  const url = req.originalUrl ?? req.url ?? "";
  return url.split("?")[0] ?? "";
}

export function signInternalRequest(
  method: string,
  path: string,
  secret: string,
): { signature: string; timestamp: number } {
  const timestamp = Math.floor(Date.now() / 1000);
  const payload = `${timestamp}.${method.toUpperCase()}.${path}`;
  const signature = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("hex");

  return { signature, timestamp };
}

export function verifyInternalRequest(
  req: InternalRequestLike,
  secret: string,
): boolean {
  const signature = getHeader(req.headers, "x-internal-signature");
  const timestampStr = getHeader(req.headers, "x-internal-timestamp");

  if (!signature || !timestampStr) {
    return false;
  }

  const timestamp = Number.parseInt(timestampStr, 10);
  if (Number.isNaN(timestamp)) {
    return false;
  }

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > TIMESTAMP_TOLERANCE_SEC) {
    return false;
  }

  const path = resolvePath(req);
  const payload = `${timestamp}.${req.method.toUpperCase()}.${path}`;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("hex");

  if (signature.length !== expected.length) {
    return false;
  }

  return crypto.timingSafeEqual(
    Buffer.from(signature, "hex"),
    Buffer.from(expected, "hex"),
  );
}

/** Active + optional previous secret for zero-downtime rotation (Phase 11). */
export function getInternalHmacSecrets(): string[] {
  const secrets: string[] = [];
  const current = process.env.INTERNAL_HMAC_SECRET?.trim();
  const previous = process.env.INTERNAL_HMAC_SECRET_PREVIOUS?.trim();

  if (current) {
    secrets.push(current);
  }
  if (previous && previous !== current) {
    secrets.push(previous);
  }

  return secrets;
}

/** Accepts signature from current or previous secret during rotation window. */
export function verifyInternalRequestWithRotation(
  req: InternalRequestLike,
  secrets?: string[],
): boolean {
  const candidates = secrets ?? getInternalHmacSecrets();
  if (candidates.length === 0) {
    return false;
  }

  return candidates.some((secret) => verifyInternalRequest(req, secret));
}
