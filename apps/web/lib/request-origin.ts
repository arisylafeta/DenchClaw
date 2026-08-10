export function requestOrigin(req: Request): string {
  const forwardedHost = req.headers.get("x-forwarded-host")?.split(",", 1)[0]?.trim();
  const forwardedProto = req.headers.get("x-forwarded-proto")?.split(",", 1)[0]?.trim().toLowerCase();
  if (
    forwardedHost &&
    (forwardedProto === "https" || forwardedProto === "http") &&
    !/[\s/\\]/.test(forwardedHost)
  ) {
    return `${forwardedProto}://${forwardedHost}`;
  }
  return new URL(req.url).origin;
}

export function hasSameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  return origin !== null && origin === requestOrigin(req);
}
