import { describe, it, expect, beforeAll } from "vitest";
import { context, propagation, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { injectTraceHeaders } from "@chat-siris/logger";
import type { Request } from "express";
import { injectInternalHeaders } from "../../src/middleware/hmac-forward.middleware";

describe("Contract: W3C traceparent propagation (P5-F-01)", () => {
  beforeAll(() => {
    process.env.INTERNAL_HMAC_SECRET = "trace-test-hmac";
    context.setGlobalContextManager(new AsyncLocalStorageContextManager());
    trace.setGlobalTracerProvider(new BasicTracerProvider());
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  });

  it("injectTraceHeaders sets traceparent on outbound headers", () => {
    const tracer = trace.getTracer("contract-test");
    tracer.startActiveSpan("gateway.proxy", (span) => {
      const headers: Record<string, string> = {};
      injectTraceHeaders(headers);
      expect(headers.traceparent).toBeDefined();
      expect(headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
      span.end();
    });
  });

  it("injectInternalHeaders includes traceparent on upstream HMAC requests", () => {
    const req = {
      method: "POST",
      path: "/api/auth/sendMessage",
      headers: {},
      logContext: { requestId: "req-trace-1" },
    } as Request;

    const tracer = trace.getTracer("contract-test");
    tracer.startActiveSpan("gateway.proxy", (span) => {
      const headers = injectInternalHeaders(req, "/internal/messages", {
        userId: "507f1f77bcf86cd799439011",
        email: "u@test.com",
        role: "user",
        jti: "jti-1",
      });

      expect(headers.traceparent).toBeDefined();
      expect(headers["X-Internal-Signature"]).toBeDefined();
      expect(headers["X-Request-Id"]).toBe("req-trace-1");
      span.end();
    });
  });
});
