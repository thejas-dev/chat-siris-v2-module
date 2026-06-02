# HMAC Secret Rotation (Zero-Downtime)

## Overview

All internal services accept **both** `INTERNAL_HMAC_SECRET` (current) and `INTERNAL_HMAC_SECRET_PREVIOUS` during a rotation window. The gateway **signs only** with the current secret.

## Staging drill (P5-NF-04) — evidence checklist

| Step | Action | Expected |
| ---- | ------ | -------- |
| 1 | Record baseline: all `/health` ok, contract tests green | Pass |
| 2 | Set `INTERNAL_HMAC_SECRET_PREVIOUS` = old secret on **all** services + gateway | No deploy yet |
| 3 | Deploy new `INTERNAL_HMAC_SECRET` on gateway only | Gateway signs with new key |
| 4 | Deploy new `INTERNAL_HMAC_SECRET` on all internal services (keep PREVIOUS=old) | Dual-key verify works |
| 5 | Run `npm test` contract + smoke login → sendMessage | No 401 on internal hops |
| 6 | Remove `INTERNAL_HMAC_SECRET_PREVIOUS` after 24h | Single-key steady state |

Record drill date, operator, and trace IDs in `hmac-rotation-drill-evidence.md`.

## Production rotation

1. Generate new random secret (≥32 bytes).
2. On all services: set `INTERNAL_HMAC_SECRET_PREVIOUS` to current value.
3. Rolling deploy: gateway first (new `INTERNAL_HMAC_SECRET`), then auth, user, group, message, media, realtime, worker.
4. Monitor 401 rate on internal routes (should stay zero).
5. After 24h, clear `INTERNAL_HMAC_SECRET_PREVIOUS` on all services.

## Failure

If internal 401s spike: revert gateway `INTERNAL_HMAC_SECRET` to previous value immediately; keep PREVIOUS on services until stable.
