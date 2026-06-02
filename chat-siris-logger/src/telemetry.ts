import { context, propagation, trace } from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { ExpressInstrumentation } from "@opentelemetry/instrumentation-express";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import {
  BatchSpanProcessor,
  type ReadableSpan,
  type SpanExporter,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";

const PII_SUBSTRINGS = [
  "password",
  "token",
  "authorization",
  "cookie",
  "jwt",
  "refresh",
  "imagekit",
];

let sdk: NodeSDK | null = null;
let initialized = false;

function isPiiAttributeKey(key: string): boolean {
  const lower = key.toLowerCase();
  return PII_SUBSTRINGS.some((part) => lower.includes(part));
}

function sanitizeSpan(span: ReadableSpan): ReadableSpan {
  const attributes: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(span.attributes)) {
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      attributes[key] = isPiiAttributeKey(key) ? "[REDACTED]" : value;
    }
  }

  return {
    name: span.name,
    kind: span.kind,
    spanContext: () => span.spanContext(),
    parentSpanContext: span.parentSpanContext,
    startTime: span.startTime,
    endTime: span.endTime,
    status: span.status,
    attributes,
    links: span.links,
    events: span.events,
    duration: span.duration,
    ended: span.ended,
    resource: span.resource,
    instrumentationScope: span.instrumentationScope,
    droppedAttributesCount: span.droppedAttributesCount,
    droppedEventsCount: span.droppedEventsCount,
    droppedLinksCount: span.droppedLinksCount,
  } as ReadableSpan;
}

class PiiRedactingSpanProcessor implements SpanProcessor {
  constructor(private readonly delegate: SpanProcessor) {}

  onStart(): void {
    /* auto-instrumentation handles span start */
  }

  onEnd(span: ReadableSpan): void {
    this.delegate.onEnd(sanitizeSpan(span));
  }

  shutdown(): Promise<void> {
    return this.delegate.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.delegate.forceFlush();
  }
}

class SanitizingSpanExporter implements SpanExporter {
  constructor(private readonly inner: SpanExporter) {}

  export(
    spans: ReadableSpan[],
    resultCallback: (result: { code: number }) => void,
  ): void {
    this.inner.export(spans.map(sanitizeSpan), resultCallback);
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }
}

function isTelemetryEnabled(): boolean {
  const flag = process.env.OTEL_ENABLED?.trim().toLowerCase();
  return flag !== "false" && flag !== "0";
}

function resolveOtlpTracesUrl(): string | undefined {
  const endpoint =
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT ??
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  if (!endpoint) {
    return undefined;
  }
  return endpoint.endsWith("/v1/traces")
    ? endpoint
    : `${endpoint.replace(/\/$/, "")}/v1/traces`;
}

/**
 * Initialize OpenTelemetry for a Chat-Siris service.
 * Call before Express/Socket.IO listen. No-op when OTEL_ENABLED=false.
 */
export function initTelemetry(serviceName: string): void {
  if (initialized || !isTelemetryEnabled()) {
    return;
  }

  propagation.setGlobalPropagator(new W3CTraceContextPropagator());

  const version =
    process.env.SERVICE_VERSION ?? process.env.npm_package_version ?? "1.0.0";
  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: serviceName,
    [ATTR_SERVICE_VERSION]: version,
  });

  const tracesUrl = resolveOtlpTracesUrl();
  const spanProcessors: SpanProcessor[] = [];

  if (tracesUrl) {
    const exporter = new SanitizingSpanExporter(
      new OTLPTraceExporter({ url: tracesUrl }),
    );
    spanProcessors.push(new PiiRedactingSpanProcessor(new BatchSpanProcessor(exporter)));
  }

  sdk = new NodeSDK({
    resource,
    spanProcessors: spanProcessors.length > 0 ? spanProcessors : undefined,
    instrumentations: [
      new HttpInstrumentation(),
      new ExpressInstrumentation(),
    ],
  });

  sdk.start();
  initialized = true;
}

export async function shutdownTelemetry(): Promise<void> {
  if (sdk) {
    await sdk.shutdown();
    sdk = null;
    initialized = false;
  }
}

/** Inject W3C traceparent into outbound HTTP headers. */
export function injectTraceHeaders(headers: Record<string, string>): void {
  propagation.inject(context.active(), headers, {
    set(carrier, key, value) {
      carrier[key] = value;
    },
  });
}

export type WorkerSpanOptions = {
  queueName: string;
  jobId?: string | number;
  requestId?: string;
};

/** Wrap BullMQ job handlers with queueName, jobId, requestId span attributes. */
export async function withWorkerSpan<T>(
  options: WorkerSpanOptions,
  fn: () => Promise<T>,
): Promise<T> {
  const tracer = trace.getTracer(process.env.SERVICE_NAME ?? "worker-service");
  return tracer.startActiveSpan(`${options.queueName}.process`, async (span) => {
    span.setAttribute("queueName", options.queueName);
    if (options.jobId !== undefined) {
      span.setAttribute("jobId", String(options.jobId));
    }
    if (options.requestId) {
      span.setAttribute("requestId", options.requestId);
    }
    try {
      return await fn();
    } catch (err) {
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      throw err;
    } finally {
      span.end();
    }
  });
}
