/** Return a same-origin destination from the login `next` parameter. */
export function getSafeLoginDestination(
  next: string | null,
  origin: string,
): string {
  if (!next || !next.startsWith("/")) return "/";

  try {
    const destination = new URL(next, origin);
    if (destination.origin !== origin) return "/";
    return `${destination.pathname}${destination.search}${destination.hash}`;
  } catch {
    return "/";
  }
}
