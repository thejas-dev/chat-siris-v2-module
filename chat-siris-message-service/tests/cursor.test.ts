import { describe, it, expect } from "vitest";
import { encodeCursor, decodeCursor, clampHistoryLimit } from "../src/utils/cursor";

describe("cursor utilities", () => {
  it("P34-NF-12: encodes and decodes compound cursor", () => {
    const cursor = {
      createdAt: "2024-01-01T00:00:00.000Z",
      _id: "507f1f77bcf86cd799439011",
    };
    const token = encodeCursor(cursor);
    expect(decodeCursor(token)).toEqual(cursor);
  });

  it("rejects invalid cursor tokens", () => {
    expect(() => decodeCursor("not-a-cursor")).toThrow("Invalid cursor token");
  });

  it("P34-F-05/F-06: clamps history limit default 50 max 100", () => {
    expect(clampHistoryLimit(undefined)).toBe(50);
    expect(clampHistoryLimit(150)).toBe(100);
    expect(clampHistoryLimit(25)).toBe(25);
  });
});
