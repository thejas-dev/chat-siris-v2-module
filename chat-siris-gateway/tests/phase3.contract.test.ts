import { describe, it, expect, beforeEach } from "vitest";
import {
  isMediaRoute,
  isMediaServiceEnabled,
  isMessageServiceEnabled,
  isMessageRoute,
  resolveUpstream,
} from "../src/config/route-map";

describe("Phase 3 message route-map contracts", () => {
  beforeEach(() => {
    process.env.AUTH_SERVICE_URL = "http://auth.test";
    process.env.USER_SERVICE_URL = "http://user.test";
    process.env.GROUP_SERVICE_URL = "http://group.test";
    process.env.MESSAGE_SERVICE_URL = "http://message.test";
    process.env.MEDIA_SERVICE_URL = "http://media.test";
    process.env.MONOLITH_URL = "http://monolith.test";
    process.env.USER_SERVICE_ENABLED = "true";
    process.env.GROUP_SERVICE_ENABLED = "true";
    delete process.env.MESSAGE_SERVICE_ENABLED;
    delete process.env.MEDIA_SERVICE_ENABLED;
  });

  it("P34-F-54: message routes rollback to monolith when disabled", () => {
    process.env.MESSAGE_SERVICE_ENABLED = "false";
    expect(isMessageServiceEnabled()).toBe(false);
    const target = resolveUpstream("/api/auth/sendMessage", "POST");
    expect(target.service).toBe("monolith");
    expect(target.url).toContain("monolith.test");
  });

  it("message routes default to message-service (Phase 10 cutover)", () => {
    expect(isMessageServiceEnabled()).toBe(true);
    const target = resolveUpstream("/api/auth/sendMessage", "POST");
    expect(target.service).toBe("message");
    expect(target.url).toBe("http://message.test/internal/messages");
  });

  it("routes sendMessage to message-service when enabled", () => {
    process.env.MESSAGE_SERVICE_ENABLED = "true";
    const target = resolveUpstream("/api/auth/sendMessage", "POST");
    expect(target.service).toBe("message");
    expect(target.url).toBe("http://message.test/internal/messages");
  });

  it("routes getMessages to history endpoint when enabled", () => {
    process.env.MESSAGE_SERVICE_ENABLED = "true";
    const target = resolveUpstream("/api/auth/getMessages", "POST");
    expect(target.service).toBe("message");
    expect(target.url).toBe("http://message.test/internal/messages/history");
  });

  it("routes deleteMessage when enabled", () => {
    process.env.MESSAGE_SERVICE_ENABLED = "true";
    const target = resolveUpstream("/api/auth/deleteMessage", "POST");
    expect(target.service).toBe("message");
    expect(target.url).toBe("http://message.test/internal/messages/delete");
  });

  it("isMessageRoute helper", () => {
    expect(isMessageRoute("/api/auth/getMessages", "POST")).toBe(true);
    expect(isMessageRoute("/api/auth/createChannel", "POST")).toBe(false);
  });

  it("media routes rollback to monolith when disabled", () => {
    process.env.MEDIA_SERVICE_ENABLED = "false";
    expect(isMediaServiceEnabled()).toBe(false);
    const target = resolveUpstream("/api/auth/media/upload-init", "POST");
    expect(target.service).toBe("monolith");
    expect(target.url).toContain("monolith.test");
  });

  it("media routes default to media-service (Phase 10 cutover)", () => {
    expect(isMediaServiceEnabled()).toBe(true);
    const target = resolveUpstream("/api/auth/media/upload-init", "POST");
    expect(target.service).toBe("media");
    expect(target.url).toBe("http://media.test/internal/media/upload-init");
  });

  it("routes upload-init to media-service when enabled", () => {
    process.env.MEDIA_SERVICE_ENABLED = "true";
    const target = resolveUpstream("/api/auth/media/upload-init", "POST");
    expect(target.service).toBe("media");
    expect(target.url).toBe("http://media.test/internal/media/upload-init");
  });

  it("routes upload-complete to media-service when enabled", () => {
    process.env.MEDIA_SERVICE_ENABLED = "true";
    const target = resolveUpstream("/api/auth/media/upload-complete", "POST");
    expect(target.service).toBe("media");
    expect(target.url).toBe("http://media.test/internal/media/upload-complete");
  });

  it("isMediaRoute helper", () => {
    expect(isMediaRoute("/api/auth/media/upload-init", "POST")).toBe(true);
    expect(isMediaRoute("/api/auth/sendMessage", "POST")).toBe(false);
  });
});
