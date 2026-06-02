import { initTelemetry } from "@chat-siris/logger";

initTelemetry(process.env.SERVICE_NAME ?? "group-service");
