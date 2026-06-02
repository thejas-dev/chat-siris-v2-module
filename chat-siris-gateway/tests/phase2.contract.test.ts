import { describe, it, expect, beforeEach } from "vitest";
import {
  TRADITY_PATHS,
  isTradityPath,
  isUserServiceEnabled,
  isGroupServiceEnabled,
  resolveUpstream,
  isProfileRoute,
  isChannelRoute,
} from "../src/config/route-map";

describe("Phase 2 route-map contracts", () => {
  beforeEach(() => {
    process.env.AUTH_SERVICE_URL = "http://auth.test";
    process.env.USER_SERVICE_URL = "http://user.test";
    process.env.GROUP_SERVICE_URL = "http://group.test";
    process.env.MESSAGE_SERVICE_URL = "http://message.test";
    process.env.MONOLITH_URL = "http://monolith.test";
    process.env.USER_SERVICE_ENABLED = "true";
    process.env.GROUP_SERVICE_ENABLED = "true";
  });

  it("P2-F-18: Tradity paths are registered", () => {
    expect(TRADITY_PATHS.has("/api/auth/tradity")).toBe(true);
    expect(TRADITY_PATHS.has("/api/auth/tradityusercheck")).toBe(true);
    expect(isTradityPath("/api/auth/gettradityimage")).toBe(true);
  });

  it("P2-F-01: updateName routes to user-service profile", () => {
    const target = resolveUpstream("/api/auth/updateName/507f1f77bcf86cd799439011", "POST");
    expect(target.service).toBe("user");
    expect(target.url).toBe(
      "http://user.test/internal/users/507f1f77bcf86cd799439011/profile",
    );
  });

  it("P2-F-05: createChannel routes to group-service", () => {
    const target = resolveUpstream("/api/auth/createChannel", "POST");
    expect(target.service).toBe("group");
    expect(target.url).toBe("http://group.test/internal/channels");
  });

  it("P2-F-27: USER_SERVICE_ENABLED=false rolls back profile routes to monolith", () => {
    process.env.USER_SERVICE_ENABLED = "false";
    const target = resolveUpstream("/api/auth/updateName/507f1f77bcf86cd799439011", "POST");
    expect(target.service).toBe("monolith");
    expect(target.url).toContain("monolith.test");
  });

  it("P2-F-28: GROUP_SERVICE_ENABLED=false rolls back channel routes to monolith", () => {
    process.env.GROUP_SERVICE_ENABLED = "false";
    const target = resolveUpstream("/api/auth/createChannel", "POST");
    expect(target.service).toBe("monolith");
  });

  it("deleteBackground transforms body to clear backgroundImage", () => {
    const target = resolveUpstream(
      "/api/auth/deleteBackground/507f1f77bcf86cd799439011",
      "POST",
    );
    expect(target.transformBody?.({}, target.url)).toEqual({
      backgroundImage: "",
    });
  });

  it("isProfileRoute and isChannelRoute helpers", () => {
    expect(isProfileRoute("/api/auth/updateAvatar/abc", "POST")).toBe(true);
    expect(isChannelRoute("/api/auth/getAllChannels", "GET")).toBe(true);
    expect(isProfileRoute("/api/auth/getMessages", "POST")).toBe(false);
  });

  it("message routes default to message-service (Phase 10 cutover)", () => {
    const target = resolveUpstream("/api/auth/getMessages", "POST");
    expect(target.service).toBe("message");
    expect(target.url).toBe("http://message.test/internal/messages/history");
  });

  it("unknown routes are unresolved (no monolith passthrough)", () => {
    const target = resolveUpstream("/api/auth/unknownRoute", "POST");
    expect(target.service).toBe("unresolved");
  });
});
