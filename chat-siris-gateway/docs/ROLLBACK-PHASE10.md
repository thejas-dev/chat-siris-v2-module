# Phase 10 rollback — monolith emergency restore

Use only if the microservices cutover must be reverted quickly.

## Gateway env vars

| Variable | Rollback value | Effect |
|----------|----------------|--------|
| `MESSAGE_SERVICE_ENABLED` | `false` | `sendMessage`, `getMessages`, `deleteMessage` → monolith |
| `MEDIA_SERVICE_ENABLED` | `false` | `upload-init`, `upload-complete` → monolith |
| `USER_SERVICE_ENABLED` | `false` | Profile routes → monolith |
| `GROUP_SERVICE_ENABLED` | `false` | Channel routes → monolith |
| `AUTH_SERVICE_ENABLED` | `false` | Login/register only → monolith |

`MONOLITH_URL` must point at a running monolith instance (default `http://localhost:3333`).

## Frontend env vars

| Variable | Rollback value |
|----------|----------------|
| `NEXT_PUBLIC_REALTIME_BASE` | Monolith socket URL (same as legacy `NEXT_PUBLIC_SERVER_BASE`) |
| `NEXT_PUBLIC_GATEWAY_BASE` | Keep gateway, or point REST at monolith if gateway is down |

## Realtime

| Variable | Drill-only value |
|----------|------------------|
| `SOCKET_AUTH_REQUIRED` | `false` (emergency only; re-enable after drill) |

## Verification after rollback

1. Login via gateway → `accessToken` present.
2. `POST /api/auth/getMessages` hits monolith (gateway logs / upstream URL).
3. Socket connects to monolith; messages still flow.
4. Re-enable flags in reverse order once root cause is fixed.
