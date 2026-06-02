# Phase 10 Rollback — Full Microservices Cutover

## When to use

Post–Phase 10 production incident: zero monolith traffic goal violated or widespread 5xx on `/api/auth/*`.

## Full rollback env (gateway)

```
AUTH_SERVICE_ENABLED=false
USER_SERVICE_ENABLED=false
GROUP_SERVICE_ENABLED=false
MESSAGE_SERVICE_ENABLED=false
MEDIA_SERVICE_ENABLED=false
MONOLITH_URL=<live monolith>
```

## Frontend rollback

```
NEXT_PUBLIC_GATEWAY_BASE=<gateway still ok for Phase 1 auth or monolith direct>
NEXT_PUBLIC_SERVER_BASE=http://<monolith>:3333
# Remove reliance on NEXT_PUBLIC_REALTIME_BASE
```

## Verification

- 48h monolith traffic monitoring shows recovery.
- `monolith-final` tag artifact still available for redeploy.
- No writes to legacy unified MongoDB from microservices.

## Forward restore

Follow Phase 10 deployment checklist in `docs/ROLLBACK-PHASE10.md`; run full smoke + contract gate before re-cutover.
