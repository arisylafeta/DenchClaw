const RAW_FILE_PATH = "/api/workspace/raw-file";

/**
 * The workspace path behind a link to this app's own raw-file route, so chat can open
 * it in a content tab instead of a new browser tab. Absolute links only count on the
 * app's own host; anything else returns null and keeps its normal link behaviour.
 */
export function rawFileLinkPath(href: string, currentHost: string): string | null {
  const value = href.trim();
  if (!value) {return null;}
  try {
    const url = new URL(value, "http://relative.invalid");
    const relative = url.origin === "http://relative.invalid";
    if (!relative && url.host.toLowerCase() !== currentHost.toLowerCase()) {return null;}
    if (url.pathname !== RAW_FILE_PATH) {return null;}
    const path = url.searchParams.get("path");
    return path ? path : null;
  } catch {
    return null;
  }
}
