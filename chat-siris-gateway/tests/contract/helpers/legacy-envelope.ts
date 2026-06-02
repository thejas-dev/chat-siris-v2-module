/** Keys allowed on legacy gateway JSON envelopes (P5-N-02 guard). */
export const LEGACY_ENVELOPE_KEYS = new Set([
  "status",
  "data",
  "user",
  "group",
  "obj",
  "pagination",
  "msg",
  "accessToken",
  "refreshToken",
]);

export function pickLegacyEnvelope(body: Record<string, unknown>): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const key of Object.keys(body)) {
    if (LEGACY_ENVELOPE_KEYS.has(key)) {
      picked[key] = body[key];
    }
  }
  return picked;
}

export function assertLegacyEnvelopeShape(body: unknown): void {
  if (typeof body !== "object" || body === null) {
    throw new Error("Response body must be an object");
  }
  const record = body as Record<string, unknown>;
  if (typeof record.status !== "boolean") {
    throw new Error('Legacy envelope must include boolean "status"');
  }
  for (const key of Object.keys(record)) {
    if (!LEGACY_ENVELOPE_KEYS.has(key)) {
      throw new Error(`Unexpected legacy envelope key: ${key}`);
    }
  }
}
