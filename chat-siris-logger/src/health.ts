export type HealthResponse = {
  status: "ok" | "degraded";
  service: string;
  uptime: number;
  redis: "ok" | "error";
  mongo?: "ok" | "error" | "n/a";
  version: string;
};

export function buildHealthResponse(deps: {
  redis?: boolean;
  mongo?: boolean;
  service: string;
  version: string;
}): HealthResponse {
  const redis: HealthResponse["redis"] =
    deps.redis === undefined || deps.redis ? "ok" : "error";

  let mongo: HealthResponse["mongo"];
  if (deps.mongo === undefined) {
    mongo = "n/a";
  } else {
    mongo = deps.mongo ? "ok" : "error";
  }

  const status: HealthResponse["status"] =
    redis === "error" || mongo === "error" ? "degraded" : "ok";

  return {
    status,
    service: deps.service,
    uptime: process.uptime(),
    redis,
    mongo,
    version: deps.version,
  };
}
