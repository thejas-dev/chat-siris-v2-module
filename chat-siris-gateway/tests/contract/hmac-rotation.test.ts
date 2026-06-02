import { describe, it, expect } from "vitest";
import {
  signInternalRequest,
  verifyInternalRequestWithRotation,
} from "@chat-siris/logger";

describe("Contract: HMAC dual-key rotation (P5-NF-04)", () => {
  const path = "/internal/messages";
  const current = "current-hmac-secret";
  const previous = "previous-hmac-secret";

  it("accepts signature from previous secret during rotation window", () => {
    const { signature, timestamp } = signInternalRequest("POST", path, previous);
    const valid = verifyInternalRequestWithRotation(
      {
        method: "POST",
        path,
        headers: {
          "x-internal-signature": signature,
          "x-internal-timestamp": String(timestamp),
        },
      },
      [current, previous],
    );
    expect(valid).toBe(true);
  });

  it("accepts signature from current secret after rotation completes", () => {
    const { signature, timestamp } = signInternalRequest("POST", path, current);
    const valid = verifyInternalRequestWithRotation(
      {
        method: "POST",
        path,
        headers: {
          "x-internal-signature": signature,
          "x-internal-timestamp": String(timestamp),
        },
      },
      [current, previous],
    );
    expect(valid).toBe(true);
  });

  it("rejects unknown secret", () => {
    const { signature, timestamp } = signInternalRequest("POST", path, "wrong");
    const valid = verifyInternalRequestWithRotation(
      {
        method: "POST",
        path,
        headers: {
          "x-internal-signature": signature,
          "x-internal-timestamp": String(timestamp),
        },
      },
      [current, previous],
    );
    expect(valid).toBe(false);
  });
});
