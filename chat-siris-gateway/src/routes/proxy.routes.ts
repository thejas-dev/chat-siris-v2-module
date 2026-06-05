import type { Request, Response } from "express";
import { injectTraceHeaders } from "@chat-siris/logger";
import { resolveUpstream } from "../config/route-map";
import { injectInternalHeaders } from "../middleware/hmac-forward.middleware";

function buildQueryString(req: Request): string {
  const query = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
  return query;
}

function forwardClientHeaders(req: Request): Record<string, string> {
  const headers: Record<string, string> = {};

  if (typeof req.headers["content-type"] === "string") {
    headers["Content-Type"] = req.headers["content-type"];
  }

  if (typeof req.headers.cookie === "string") {
    headers.Cookie = req.headers.cookie;
  }

  if (typeof req.headers.authorization === "string") {
    headers.Authorization = req.headers.authorization;
  }

  return headers;
}

function buildUpstreamHeaders(
  req: Request,
  target: ReturnType<typeof resolveUpstream>,
): Record<string, string> {
  const requestId =
    req.logContext?.requestId ??
    (typeof req.headers["x-request-id"] === "string"
      ? req.headers["x-request-id"]
      : "");

  if (target.service === "monolith") {
    const headers = {
      ...forwardClientHeaders(req),
      "X-Request-Id": requestId,
    };
    injectTraceHeaders(headers);
    return headers;
  }

  if (
    (target.service === "user" ||
      target.service === "group" ||
      target.service === "message" ||
      target.service === "media") &&
    target.internalPath
  ) {
    return {
      ...forwardClientHeaders(req),
      ...injectInternalHeaders(req, target.internalPath, req.authClaims),
    };
  }

  const headers = {
    ...forwardClientHeaders(req),
    "X-Request-Id": requestId,
  };
  injectTraceHeaders(headers);
  return headers;
}

async function readRequestBody(
  req: Request,
  target: ReturnType<typeof resolveUpstream>,
): Promise<string | undefined> {
  if (req.method === "GET" || req.method === "HEAD") {
    return undefined;
  }

  let body = req.body;
  if (target.transformBody) {
    body = target.transformBody(body, req.path);
  }

  if (body === undefined || body === null) {
    return undefined;
  }

  if (typeof body === "object" && Object.keys(body as object).length === 0) {
    return "{}";
  }

  return JSON.stringify(body);
}

const UPSTREAM_STRIP_HEADERS = new Set([
  "transfer-encoding",
  // fetch/undici already decompresses the upstream body before we re-send it, so
  // forwarding the upstream's content-encoding/content-length would make the client
  // try to gunzip a plain body ("Decompression failed") or read a wrong length.
  // Express sets its own Content-Length on res.json()/res.send().
  "content-encoding",
  "content-length",
  "access-control-allow-origin",
  "access-control-allow-credentials",
  "access-control-allow-methods",
  "access-control-allow-headers",
  "access-control-expose-headers",
  "access-control-max-age",
]);

function copyResponseHeaders(
  upstream: globalThis.Response,
  res: Response,
): void {
  upstream.headers.forEach((value, key) => {
    if (UPSTREAM_STRIP_HEADERS.has(key.toLowerCase())) {
      return;
    }
    res.setHeader(key, value);
  });
}

export async function proxyHandler(req: Request, res: Response): Promise<void> {
  const target = resolveUpstream(req.path, req.method);

  if (target.service === "unresolved") {
    res.status(404).json({ status: false, msg: "Route not found" });
    return;
  }

  const query = buildQueryString(req);
  const url = `${target.url}${query}`;
  const headers = buildUpstreamHeaders(req, target);
  const body = await readRequestBody(req, target);

  const upstream = await fetch(url, {
    method: req.method,
    headers,
    body,
  });

  copyResponseHeaders(upstream, res);
  res.status(upstream.status);

  const contentType = upstream.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const json = await upstream.json();
    res.json(json);
    return;
  }

  const text = await upstream.text();
  res.send(text);
}
