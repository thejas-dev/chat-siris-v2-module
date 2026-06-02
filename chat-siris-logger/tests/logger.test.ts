import { describe, expect, it } from "vitest";
import winston from "winston";
import Transport from "winston-transport";
import { createLogger } from "../src/index";

class CaptureTransport extends Transport {
  logs: winston.Logform.TransformableInfo[] = [];

  log(info: winston.Logform.TransformableInfo, callback: () => void): void {
    this.logs.push(info);
    callback();
  }
}

describe("createLogger", () => {
  it("emits JSON with timestamp, level, service, and message fields", () => {
    const originalEnv = process.env.LOKI_HOST;
    delete process.env.LOKI_HOST;

    const logger = createLogger("test-service");
    const capture = new CaptureTransport();
    logger.clear();
    logger.add(capture);
    logger.info("hello world");

    if (originalEnv !== undefined) {
      process.env.LOKI_HOST = originalEnv;
    } else {
      delete process.env.LOKI_HOST;
    }

    expect(capture.logs).toHaveLength(1);
    const entry = capture.logs[0];
    expect(entry.timestamp).toBeDefined();
    expect(entry.level).toBe("info");
    expect(entry.service).toBe("test-service");
    expect(entry.message).toBe("hello world");
  });
});
