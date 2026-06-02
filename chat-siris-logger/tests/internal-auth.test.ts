import crypto from "crypto";
import { describe, expect, it } from "vitest";
import {
  signInternalRequest,
  verifyInternalRequest,
  verifyInternalRequestWithRotation,
  getInternalHmacSecrets,
  type InternalRequestLike,
} from "../src/internal-auth";

const SECRET = "test-hmac-secret";
const PATH = "/internal/users/abc123";

function buildRequest(
  method: string,
  path: string,
  signature: string,
  timestamp: number,
): InternalRequestLike {
  return {
    method,
    path,
    headers: {
      "x-internal-signature": signature,
      "x-internal-timestamp": String(timestamp),
    },
  };
}

describe("signInternalRequest / verifyInternalRequest", () => {
  it("returns true for a valid signature within ±60s", () => {
    const { signature, timestamp } = signInternalRequest("GET", PATH, SECRET);
    const req = buildRequest("GET", PATH, signature, timestamp);

    expect(verifyInternalRequest(req, SECRET)).toBe(true);
  });

  it("returns false for a timestamp older than 60s", () => {
    const expiredTimestamp = Math.floor(Date.now() / 1000) - 61;
    const payload = `${expiredTimestamp}.GET.${PATH}`;
    const signature = crypto
      .createHmac("sha256", SECRET)
      .update(payload)
      .digest("hex");
    const req = buildRequest("GET", PATH, signature, expiredTimestamp);

    expect(verifyInternalRequest(req, SECRET)).toBe(false);
  });

  it("returns false for the wrong secret", () => {
    const { signature, timestamp } = signInternalRequest("GET", PATH, SECRET);
    const req = buildRequest("GET", PATH, signature, timestamp);

    expect(verifyInternalRequest(req, "wrong-secret")).toBe(false);
  });

  it("P5-NF-04: accepts previous secret during dual-key rotation window", () => {
    const previous = "previous-rotation-secret";
    const current = "current-rotation-secret";
    const { signature, timestamp } = signInternalRequest("GET", PATH, previous);
    const req = buildRequest("GET", PATH, signature, timestamp);

    expect(
      verifyInternalRequestWithRotation(req, [current, previous]),
    ).toBe(true);
    expect(verifyInternalRequest(req, current)).toBe(false);
    expect(verifyInternalRequest(req, previous)).toBe(true);
  });

  it("getInternalHmacSecrets deduplicates identical current and previous", () => {
    process.env.INTERNAL_HMAC_SECRET = "same";
    process.env.INTERNAL_HMAC_SECRET_PREVIOUS = "same";
    expect(getInternalHmacSecrets()).toEqual(["same"]);
    delete process.env.INTERNAL_HMAC_SECRET;
    delete process.env.INTERNAL_HMAC_SECRET_PREVIOUS;
  });
});
