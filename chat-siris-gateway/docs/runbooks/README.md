# Chat-Siris Incident Runbooks

Operational rollback and observability guides for Phases 1–10.  
**OTel collector:** Grafana Tempo (or any OTLP HTTP endpoint) via `OTEL_EXPORTER_OTLP_ENDPOINT`.

## Index

| Phase | Runbook | Rollback env vars |
| ----- | ------- | ----------------- |
| 1 | [phase-1-auth-jwt.md](./phase-1-auth-jwt.md) | `AUTH_SERVICE_ENABLED=false` |
| 2 | [phase-2-profile-channels.md](./phase-2-profile-channels.md) | `USER_SERVICE_ENABLED`, `GROUP_SERVICE_ENABLED` |
| 3–4 | [phase-3-4-messages-realtime.md](./phase-3-4-messages-realtime.md) | `MESSAGE_SERVICE_ENABLED`, `MEDIA_SERVICE_ENABLED`, frontend URLs |
| 10 | [phase-10-production-cutover.md](./phase-10-production-cutover.md) | Full stack rollback |
| HMAC | [hmac-secret-rotation.md](./hmac-secret-rotation.md) | `INTERNAL_HMAC_SECRET`, `INTERNAL_HMAC_SECRET_PREVIOUS` |
| OTel | [opentelemetry.md](./opentelemetry.md) | `OTEL_ENABLED=false` |

## Verification after any rollback

1. `GET /health` on gateway (8080) and affected services return `status: ok`.
2. Login → join channel → send message → socket `msg-recieve` within 2s.
3. Gateway access logs show zero traffic to retired upstreams.
4. Contract tests pass: `npm test` in `chat-siris-gateway`.
