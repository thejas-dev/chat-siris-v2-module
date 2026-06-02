import { describe, it, expect } from "vitest";
import { notificationJobId } from "../src/services/queue.service";

describe("notificationJobId", () => {
  it("uses messageId only and avoids BullMQ-invalid colon separators", () => {
    const messageId = "674a1b2c3d4e5f6789012345";
    expect(notificationJobId(messageId)).toBe(messageId);
    expect(notificationJobId(messageId)).not.toContain(":");
  });
});
