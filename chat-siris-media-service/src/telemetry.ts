import { initTelemetry } from "@chat-siris/logger";

// src/index.ts imports this first so OpenTelemetry instruments http/express before
// they load. Skipped under tests so vitest runs don't start the OTel SDK.
if (process.env.NODE_ENV !== "test" && !process.env.VITEST) {
  initTelemetry(process.env.SERVICE_NAME ?? "media-service");
}
