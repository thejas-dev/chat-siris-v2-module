import { describe, it, expect, beforeEach } from "vitest";
import {
  AUTH_PUBLIC_PATHS,
  AUTH_SERVICE_PATHS,
  TRADITY_PATHS,
  resolveUpstream,
} from "../../src/config/route-map";

const SAMPLE_ID = "507f1f77bcf86cd799439011";

/** Every production `/api/auth/*` route the gateway must handle (Phase 11 contract gate). */
export const GATEWAY_API_AUTH_ROUTES: Array<{ method: string; path: string }> = [
  ...AUTH_PUBLIC_PATHS.map((path) => ({ method: "POST", path })),
  { method: "POST", path: `/api/auth/updateUser/${SAMPLE_ID}` },
  { method: "POST", path: `/api/auth/deleteBackground/${SAMPLE_ID}` },
  { method: "POST", path: `/api/auth/updateName/${SAMPLE_ID}` },
  { method: "POST", path: `/api/auth/updateAvatar/${SAMPLE_ID}` },
  { method: "POST", path: `/api/auth/addChannelToUser/${SAMPLE_ID}` },
  { method: "POST", path: "/api/auth/subscribe" },
  { method: "POST", path: "/api/auth/createChannel" },
  { method: "GET", path: "/api/auth/getAllChannels" },
  { method: "POST", path: `/api/auth/addUserToChannel/${SAMPLE_ID}` },
  { method: "POST", path: "/api/auth/fetchUserRoom" },
  { method: "POST", path: "/api/auth/findChannelRoute" },
  { method: "POST", path: `/api/auth/channelAdminUpdate/${SAMPLE_ID}` },
  { method: "POST", path: "/api/auth/sendMessage" },
  { method: "POST", path: "/api/auth/getMessages" },
  { method: "POST", path: "/api/auth/deleteMessage" },
  { method: "POST", path: "/api/auth/media/upload-init" },
  { method: "POST", path: "/api/auth/media/upload-complete" },
  ...[...TRADITY_PATHS].map((path) => ({ method: "POST", path })),
];

describe("Contract: /api/auth/* route coverage", () => {
  beforeEach(() => {
    process.env.AUTH_SERVICE_URL = "http://auth.test";
    process.env.USER_SERVICE_URL = "http://user.test";
    process.env.GROUP_SERVICE_URL = "http://group.test";
    process.env.MESSAGE_SERVICE_URL = "http://message.test";
    process.env.MEDIA_SERVICE_URL = "http://media.test";
    process.env.USER_SERVICE_ENABLED = "true";
    process.env.GROUP_SERVICE_ENABLED = "true";
    process.env.MESSAGE_SERVICE_ENABLED = "true";
    process.env.MEDIA_SERVICE_ENABLED = "true";
  });

  it("P5-F-04: documents every gateway /api/auth route", () => {
    expect(GATEWAY_API_AUTH_ROUTES.length).toBeGreaterThanOrEqual(24);
  });

  it("P5-F-04: auth public paths match AUTH_SERVICE_PATHS", () => {
    for (const path of AUTH_PUBLIC_PATHS) {
      if (path === "/api/auth/token/refresh") {
        continue;
      }
      const key = `POST ${path}`;
      expect(AUTH_SERVICE_PATHS.has(key)).toBe(true);
    }
  });

  it("P5-F-04: microservice routes resolve (not unresolved)", () => {
    for (const route of GATEWAY_API_AUTH_ROUTES) {
      if (TRADITY_PATHS.has(route.path)) {
        continue;
      }
      const target = resolveUpstream(route.path, route.method);
      expect(target.service).not.toBe("unresolved");
    }
  });
});
