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

const IMAGE_FILE = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i;

/** Undo only what a markdown parser adds to a destination (spaces and non-ASCII bytes), so names with a literal % stay intact. */
function undoParserEncoding(path: string): string {
  return path
    .replace(/%20/g, " ")
    .replace(/(?:%[89A-Fa-f][0-9A-Fa-f])+/g, (run) => { try { return decodeURIComponent(run); } catch { return run; } });
}

/**
 * Where a markdown image in chat should load from. Web https/http, data:image and blob
 * images and this app's own raw-file URLs load as written; a local path (absolute, relative
 * or file://) to an image file is served through the raw-file route so an image the agent
 * saved in the workspace shows inline. `path` is the workspace path, so a click can open it
 * in a content tab. Anything else (other /api routes, protocol-relative URLs, other schemes,
 * non-image files such as html) returns an empty src and the caller shows the alt text.
 */
export function chatImageSource(src: string, currentHost = ""): { src: string; path: string | null } {
  const none = { src: "", path: null };
  const value = src.trim();
  if (!value) {return none;}
  if (value.startsWith("//")) {return none;}
  const own = (url: string): { src: string; path: string | null } => {
    const path = rawFileLinkPath(url, currentHost);
    return path && IMAGE_FILE.test(path) ? { src: url, path } : none;
  };
  if (/^https?:/i.test(value)) {
    try {
      const url = new URL(value);
      // Without a known host (server render) any absolute /api/ URL could be this app's own, so refuse it.
      if (!currentHost ? url.pathname.startsWith("/api/") : url.host.toLowerCase() === currentHost.toLowerCase()) {
        return url.pathname === RAW_FILE_PATH && currentHost ? own(value) : none;
      }
    } catch { return none; }
    return { src: value, path: null };
  }
  if (/^(data:image\/|blob:)/i.test(value)) {return { src: value, path: null };}
  if (value.startsWith(`${RAW_FILE_PATH}?`)) {return own(value);}
  if (value.startsWith("/api/")) {return none;}
  let path = value;
  if (/^file:\/\//i.test(path)) {
    try {
      const url = new URL(path);
      if (url.host && url.host.toLowerCase() !== "localhost") {return none;}
      path = decodeURIComponent(url.pathname);
    } catch { return none; }
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(path)) {
    return none;
  } else {
    path = undoParserEncoding(path);
  }
  if (!IMAGE_FILE.test(path)) {return none;}
  return { src: `${RAW_FILE_PATH}?path=${encodeURIComponent(path)}`, path };
}
