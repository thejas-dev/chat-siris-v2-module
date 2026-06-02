# OpenTelemetry Operations

## Collector destination

- **Recommended:** Grafana Cloud Tempo or self-hosted Tempo
- **Env:** `OTEL_EXPORTER_OTLP_ENDPOINT=https://<tempo-host>` (appends `/v1/traces` automatically)
- **Disable:** `OTEL_ENABLED=false` (instant rollback, P5-R-01)

## Propagation

- Gateway injects W3C `traceparent` on all upstream HTTP (microservices + monolith rollback).
- Message flow: gateway → message-service → group-service `authorize` appears as linked spans.
- Pub/sub: worker and realtime spans include `requestId` attribute from job/event payload.

## PII guard (P5-N-01)

Span attributes matching `password`, `token`, `authorization`, `cookie`, `jwt`, `refresh`, `imagekit` are exported as `[REDACTED]`.

**Never** add to spans: JWT bodies, refresh tokens, channel passwords, ImageKit private key.

## Performance rollback (P5-R-01)

If gateway P95 increases >5% sustained for 15 minutes after OTel enable:

1. Set `OTEL_ENABLED=false` on gateway first.
2. Then disable on other services.
3. File incident; investigate sampler or exporter batch size.
