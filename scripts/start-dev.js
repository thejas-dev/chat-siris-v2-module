#!/usr/bin/env node
/**
 * Start the Chat-Siris v2 microservices stack for local development.
 *
 * Excludes the legacy Chat-Siris-v2-Server monolith (deprecated).
 *
 * Prerequisites (start separately):
 *   - Redis on localhost:6379 (single instance: set REDIS_URL + REDIS_DB_CACHE/EVENTS in each .env)
 *   - Or Upstash: set REDIS_CACHE_URL and REDIS_EVENTS_URL per service in each .env
 *   - MongoDB (Atlas or local) — each service reads its own .env
 *
 * Usage:
 *   node scripts/start-dev.js
 *   node scripts/start-dev.js --skip-logger-build
 *   node scripts/start-dev.js --only=user-service,gateway,frontend
 */

const { spawn, execSync } = require("child_process");
const net = require("net");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

/** @type {Array<{ id: string; dir: string; port: number; delayMs: number }>} */
const SERVICES = [
  { id: "user-service", dir: "chat-siris-user-service", port: 3002, delayMs: 0 },
  { id: "auth-service", dir: "chat-siris-auth-service", port: 3001, delayMs: 2500 },
  { id: "group-service", dir: "chat-siris-group-service", port: 3003, delayMs: 1500 },
  { id: "message-service", dir: "chat-siris-message-service", port: 3004, delayMs: 1500 },
  { id: "media-service", dir: "chat-siris-media-service", port: 3005, delayMs: 1500 },
  { id: "worker-service", dir: "chat-siris-worker-service", port: 3006, delayMs: 1500 },
  { id: "realtime-service", dir: "chat-siris-realtime-service", port: 3333, delayMs: 2000 },
  { id: "gateway", dir: "chat-siris-gateway", port: 8080, delayMs: 2000 },
  { id: "frontend", dir: "chat-siris-v2", port: 3000, delayMs: 1500 },
];

const COLORS = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
  blue: "\x1b[34m",
};

const SERVICE_COLORS = [
  COLORS.cyan,
  COLORS.green,
  COLORS.yellow,
  COLORS.magenta,
  COLORS.blue,
  COLORS.cyan,
  COLORS.green,
  COLORS.yellow,
  COLORS.magenta,
];

/** @type {import("child_process").ChildProcess[]} */
const children = [];

function parseArgs(argv) {
  const skipLoggerBuild = argv.includes("--skip-logger-build");
  const onlyFlag = argv.find((arg) => arg.startsWith("--only="));
  const only = onlyFlag
    ? onlyFlag
        .slice("--only=".length)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : null;
  return { skipLoggerBuild, only };
}

function log(message, color = COLORS.reset) {
  process.stdout.write(`${color}${message}${COLORS.reset}\n`);
}

function checkTcp(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.on("connect", () => done(true));
    socket.on("timeout", () => done(false));
    socket.on("error", () => done(false));
  });
}

function buildLogger() {
  const loggerDir = path.join(ROOT, "chat-siris-logger");
  log("\nBuilding @chat-siris/logger (required by all backend services)...", COLORS.dim);
  execSync("npm run build", { cwd: loggerDir, stdio: "inherit" });
}

function prefixLines(serviceId, color, stream) {
  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.length === 0) continue;
      process.stdout.write(`${color}[${serviceId}]${COLORS.reset} ${line}\n`);
    }
  });
}

function startService(service, color) {
  const cwd = path.join(ROOT, service.dir);
  log(`Starting ${service.id} (port ${service.port})...`, color);

  const child = spawn("npm", ["run", "dev"], {
    cwd,
    env: { ...process.env, FORCE_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
    detached: process.platform !== "win32",
  });

  children.push(child);

  prefixLines(service.id, color, child.stdout);
  prefixLines(service.id, color, child.stderr);

  child.on("exit", (code, signal) => {
    if (signal) {
      log(`${service.id} stopped (${signal})`, COLORS.dim);
    } else if (code !== 0 && code !== null) {
      log(`${service.id} exited with code ${code}`, COLORS.red);
    }
  });

  return child;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shutdown() {
  log("\nShutting down all services...", COLORS.yellow);
  for (const child of children) {
    if (!child.killed && child.pid) {
      if (process.platform === "win32") {
        child.kill("SIGTERM");
      } else {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          child.kill("SIGTERM");
        }
      }
    }
  }
  setTimeout(() => {
    for (const child of children) {
      if (!child.killed && child.pid) {
        if (process.platform === "win32") {
          child.kill("SIGKILL");
        } else {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        }
      }
    }
    process.exit(0);
  }, 3000);
}

async function main() {
  const { skipLoggerBuild, only } = parseArgs(process.argv.slice(2));

  const selected = only
    ? SERVICES.filter((s) => only.includes(s.id))
    : SERVICES;

  if (selected.length === 0) {
    log("No services matched --only filter.", COLORS.red);
    log(`Available: ${SERVICES.map((s) => s.id).join(", ")}`, COLORS.dim);
    process.exit(1);
  }

  log("Chat-Siris v2 — local development stack", COLORS.green);
  log("(Chat-Siris-v2-Server monolith is intentionally excluded)\n", COLORS.dim);

  const redisUp = await checkTcp("127.0.0.1", 6379);
  if (!redisUp) {
    log("Warning: Redis does not appear to be running on localhost:6379.", COLORS.yellow);
    log("Start Redis first, e.g.  docker run -d --name chat-redis -p 6379:6379 redis:7-alpine\n", COLORS.dim);
  }

  if (!skipLoggerBuild) {
    buildLogger();
  }

  log("\nStarting services (Ctrl+C to stop all):\n", COLORS.green);

  for (let i = 0; i < selected.length; i++) {
    const service = selected[i];
    const color = SERVICE_COLORS[SERVICES.indexOf(service)] ?? COLORS.cyan;

    if (service.delayMs > 0) {
      await sleep(service.delayMs);
    }

    startService(service, color);
  }

  log("\nStack starting. Endpoints:", COLORS.green);
  log("  Frontend   http://localhost:3000", COLORS.dim);
  log("  Gateway    http://localhost:8080/health", COLORS.dim);
  log("  Realtime   http://localhost:3333 (Socket.IO)", COLORS.dim);
  log("  Services   3001 auth · 3002 user · 3003 group · 3004 message · 3005 media · 3006 worker\n", COLORS.dim);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((err) => {
  log(`Fatal: ${err.message}`, COLORS.red);
  shutdown();
});
