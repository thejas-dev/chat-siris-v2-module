# HMAC Rotation Drill Evidence (Staging)

| Field | Value |
| ----- | ----- |
| Drill date | _YYYY-MM-DD_ |
| Operator | _name_ |
| Environment | staging |
| Gateway version | _git sha_ |

## Results

- [ ] Baseline contract tests: `npm test` in `chat-siris-gateway` — pass
- [ ] Dual-key window: requests signed with **previous** secret accepted by services
- [ ] Gateway signed with **current** secret: login → sendMessage trace — no internal 401
- [ ] Zero user-facing outage during rotation window
- [ ] `INTERNAL_HMAC_SECRET_PREVIOUS` removed after cooldown — pass

## Sample trace (requestId)

```
requestId: _______________________
traceparent: 00-________________-________________-01
```

## Notes

_Add any anomalies or rollback actions taken._
