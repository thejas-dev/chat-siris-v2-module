import { describe, it, expect } from "vitest";
import {
  FileTooLargeError,
  normalizeImageKitPublicKey,
  validateFileSize,
} from "../src/services/imagekit.service";

describe("normalizeImageKitPublicKey", () => {
  it("appends = when missing from public_ keys", () => {
    expect(normalizeImageKitPublicKey("public_abc123")).toBe("public_abc123=");
  });

  it("leaves keys that already end with = unchanged", () => {
    expect(normalizeImageKitPublicKey("public_abc123=")).toBe("public_abc123=");
  });
});

describe("imagekit.service validateFileSize", () => {
  it("allows video at exactly 16 MB", () => {
    expect(() =>
      validateFileSize("video/mp4", 16 * 1024 * 1024),
    ).not.toThrow();
  });

  it("throws FileTooLargeError for video over 16 MB", () => {
    expect(() =>
      validateFileSize("video/mp4", 16 * 1024 * 1024 + 1),
    ).toThrow(FileTooLargeError);
  });

  it("allows non-video at exactly 25 MB", () => {
    expect(() =>
      validateFileSize("application/pdf", 25 * 1024 * 1024),
    ).not.toThrow();
  });

  it("throws FileTooLargeError for non-video over 25 MB", () => {
    expect(() =>
      validateFileSize("application/pdf", 25 * 1024 * 1024 + 1),
    ).toThrow(FileTooLargeError);
  });
});
