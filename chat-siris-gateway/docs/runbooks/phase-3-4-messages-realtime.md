# Phase 3+4 Rollback — Messages, Media, Realtime

## When to use

Messages not persisting, pagination broken, socket `msg-recieve` missing, or upload-init failures.

## Rollback steps

1. `MESSAGE_SERVICE_ENABLED=false` — send/get/delete message → monolith.
2. `MEDIA_SERVICE_ENABLED=false` — upload routes → monolith.
3. Frontend: set `NEXT_PUBLIC_SERVER_BASE` to monolith socket URL; unset `NEXT_PUBLIC_REALTIME_BASE` for emergency.
4. Optional emergency only: `SOCKET_AUTH_REQUIRED=false` on realtime-service (document in incident ticket).
5. Redeploy gateway + frontend together.

## Verification

- REST sendMessage returns `{ status, data }` within 2s.
- Socket receives `msg-recieve` on channel room.
- `getMessages` returns messages (monolith may return full history — expected on rollback).

## Restore

Re-enable message + media flags; point frontend to `NEXT_PUBLIC_REALTIME_BASE`; deploy message + realtime + gateway in **one release** (Hard Constraint #13).
