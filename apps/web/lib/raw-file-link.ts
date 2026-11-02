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

/**
 * Where a markdown image in chat should load from. Web, data and blob sources and
 * the app's own /api routes load as written; a local path (absolute, relative or
 * file://) is served through the raw-file route so an image the agent saved in the
 * workspace shows inline instead of as a broken link. Returns the workspace path
 * too when the image is local, so a click can open it in a content tab.
 */
export function chatImageSource(src: string): { src: string; path: string | null } {
  const value = src.trim();
  if (!value) {return { src: "", path: null };}
  if (/^(https?:|data:image\/|blob:)/i.test(value) || value.startsWith("//") || value.startsWith(`${RAW_FILE_PATH}?`)) {
    return { src: value, path: rawFileLinkPath(value, "") };
  }
  if (value.startsWith("/api/")) {return { src: value, path: null };}
  let path = value;
  if (/^file:\/\//i.test(path)) {
    try { path = decodeURIComponent(new URL(path).pathname); } catch { return { src: "", path: null }; }
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(path)) {
    return { src: "", path: null };
  }
  // Markdown parsers percent-encode spaces in a destination; undo that once so the path is not encoded twice.
  try { path = decodeURIComponent(path); } catch { /* keep the literal text */ }
  return { src: `${RAW_FILE_PATH}?path=${encodeURIComponent(path)}`, path };
}
