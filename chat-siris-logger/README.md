# @chat-siris/logger

Shared logging, internal HMAC authentication, and health response utilities for Chat-Siris v2 backend services.

## Installation

```bash
npm install @chat-siris/logger
```

For local development across repos:

```bash
npm link
# or in a service package.json:
# "@chat-siris/logger": "file:../chat-siris-logger"
```

## Usage

```typescript
import {
  createLogger,
  requestContextMiddleware,
  logWithContext,
  signInternalRequest,
  verifyInternalRequest,
  buildHealthResponse,
} from "@chat-siris/logger";

const logger = createLogger("auth-service");
app.use(requestContextMiddleware());

logWithContext(req, "info", "User logged in");

const { signature, timestamp } = signInternalRequest("GET", "/internal/users/1", secret);
const valid = verifyInternalRequest(req, secret);

const health = buildHealthResponse({
  service: "auth-service",
  version: "1.0.0",
  redis: true,
  mongo: true,
});
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `LOG_LEVEL` | Winston log level (default: `info`) |
| `LOKI_HOST` | Loki push URL; when set, enables Loki transport |
| `LOKI_USER` | Loki basic auth username |
| `LOKI_API_KEY` | Loki basic auth password |
| `NODE_ENV` | `development` enables console transport |

## Subpath Exports

- `@chat-siris/logger/internal-auth` — HMAC sign/verify helpers
- `@chat-siris/logger/health` — `buildHealthResponse` and `HealthResponse` type
