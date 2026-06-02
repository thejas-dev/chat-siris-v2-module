function parseOriginPattern(pattern: string): (origin: string) => boolean {
  const trimmed = pattern.trim();
  if (!trimmed) {
    return () => false;
  }

  if (trimmed.includes("*")) {
    const escaped = trimmed
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*");
    const regex = new RegExp(`^${escaped}$`);
    return (origin) => regex.test(origin);
  }

  return (origin) => origin === trimmed;
}

export function buildCorsOriginChecker(): (
  origin: string | undefined,
  callback: (err: Error | null, allow?: boolean) => void,
) => void {
  const raw = process.env.CORS_ORIGINS ?? "http://localhost:3000";
  const patterns = raw.split(",").map((p) => parseOriginPattern(p));

  return (origin, callback) => {
    if (!origin) {
      callback(null, true);
      return;
    }

    const allowed = patterns.some((match) => match(origin));
    callback(null, allowed);
  };
}
