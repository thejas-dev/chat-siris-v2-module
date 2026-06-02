import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { verifyInternalRequest, signInternalRequest } from "@chat-siris/logger";

const HMAC_SECRET = "test-hmac-secret-authorize";
const CHANNEL_ID = "6a1b3965db26841d21b4b948";
const USER_ID = "6a1b329879a56595800f88e0";

function asHeaderRecord(
  headers: HeadersInit | undefined,
): Record<string, string | string[] | undefined> {
  const raw: Record<string, string | string[] | undefined> = {};
  if (!headers) {
    return raw;
  }
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      raw[key.toLowerCase()] = value;
    });
    return raw;
  }
  for (const [key, value] of Object.entries(
    headers as Record<string, string | string[] | undefined>,
  )) {
    raw[key.toLowerCase()] = value;
  }
  return raw;
}

describe("authorize.client", () => {
  const fetchMock = vi.fn();
  const originalSecret = process.env.INTERNAL_HMAC_SECRET;
  const originalGroupUrl = process.env.GROUP_SERVICE_URL;

  beforeEach(() => {
    process.env.INTERNAL_HMAC_SECRET = HMAC_SECRET;
    process.env.GROUP_SERVICE_URL = "http://group.test";
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    vi.resetModules();
  });

  afterEach(() => {
    process.env.INTERNAL_HMAC_SECRET = originalSecret;
    process.env.GROUP_SERVICE_URL = originalGroupUrl;
    vi.unstubAllGlobals();
  });

  it("signs authorize GET without query string (group-service HMAC contract)", async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes("/lookup")) {
        return new Response(
          JSON.stringify({ status: true, data: { _id: CHANNEL_ID } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (url.includes("/authorize")) {
        return new Response(JSON.stringify({ allowed: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response(null, { status: 404 });
    });

    const { authorizeSend } = await import("../src/services/authorize.client");
    process.env.INTERNAL_HMAC_SECRET = HMAC_SECRET;
    process.env.GROUP_SERVICE_URL = "http://group.test";
    const result = await authorizeSend(USER_ID, "general8");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("ok");

    const authorizeCall = fetchMock.mock.calls.find((call) =>
      String(call[0]).includes("/authorize"),
    );
    const signedPath = `/internal/channels/${CHANNEL_ID}/authorize`;
    const authorizeUrl = String(authorizeCall?.[0] ?? "");
    const authorizeHeaders = asHeaderRecord(
      authorizeCall?.[1]?.headers,
    ) as Record<string, string>;

    expect(authorizeUrl).toContain("userId=");
    expect(authorizeUrl).toContain("action=send");

    expect(
      verifyInternalRequest(
        { method: "GET", path: signedPath, headers: authorizeHeaders },
        process.env.INTERNAL_HMAC_SECRET ?? HMAC_SECRET,
      ),
    ).toBe(true);

    expect(
      verifyInternalRequest(
        {
          method: "GET",
          path: `${signedPath}?userId=${USER_ID}&action=send`,
          headers: authorizeHeaders,
        },
        process.env.INTERNAL_HMAC_SECRET ?? HMAC_SECRET,
      ),
    ).toBe(false);

    const { signature, timestamp } = signInternalRequest(
      "GET",
      signedPath,
      process.env.INTERNAL_HMAC_SECRET ?? HMAC_SECRET,
    );
    expect(authorizeHeaders["x-internal-signature"]).toBe(signature);
    expect(authorizeHeaders["x-internal-timestamp"]).toBe(String(timestamp));
  });
});
