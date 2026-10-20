/** Agent-drawn visuals: ```visual (or ```visualizer) fences carrying an SVG or HTML fragment, rendered in a sandboxed iframe. */
export type VisualPiece = { type: "text"; text: string } | { type: "visual"; code: string; closed: boolean };

const OPEN = /^[ \t]*```(?:visual|visualizer)[ \t]*$/;
const CLOSE = /^[ \t]*```[ \t]*$/;

/** Split markdown into text and visual pieces. An unclosed fence (still streaming) yields `closed: false`. */
export function splitVisualBlocks(text: string): VisualPiece[] {
  if (!/```visual/.test(text)) return [{ type: "text", text }];
  const pieces: VisualPiece[] = [];
  const lines = text.split("\n");
  let buffer: string[] = [];
  let i = 0;
  const flush = () => { const joined = buffer.join("\n"); if (joined.trim()) pieces.push({ type: "text", text: joined }); buffer = []; };
  while (i < lines.length) {
    if (OPEN.test(lines[i])) {
      flush();
      const body: string[] = [];
      i++;
      while (i < lines.length && !CLOSE.test(lines[i])) body.push(lines[i++]);
      const closed = i < lines.length;
      pieces.push({ type: "visual", code: body.join("\n"), closed });
      i++;
    } else buffer.push(lines[i++]);
  }
  flush();
  return pieces;
}

export const VISUAL_THEME_VARS = ["--color-text", "--color-text-muted", "--color-bg", "--color-surface", "--color-surface-hover", "--color-border", "--color-accent", "--color-accent-foreground", "--color-error"] as const;

const CSP = "default-src 'none'; script-src 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com https://esm.sh; style-src 'unsafe-inline'; img-src data: blob:; font-src https://cdnjs.cloudflare.com https://cdn.jsdelivr.net; connect-src 'none'; form-action 'none'";

const BASE_CSS = `
html,body{margin:0;background:transparent;color:var(--color-text);font:14px/1.5 system-ui,-apple-system,sans-serif}
svg{max-width:100%;height:auto;display:block}
svg text{font:400 13px system-ui,-apple-system,sans-serif;fill:var(--color-text)}
.ts{font-size:11px;fill:var(--color-text-muted)}
.th{font-weight:600}
.box{fill:var(--color-surface-hover);stroke:var(--color-border)}
.accent{fill:var(--color-accent);stroke:var(--color-accent)}
.arr{stroke:var(--color-text-muted);stroke-width:1.5;fill:none}
.node{cursor:pointer}.node:hover{opacity:.85}
button{font:inherit;font-size:13px;color:var(--color-text);background:var(--color-surface-hover);border:0;border-radius:8px;padding:6px 12px;cursor:pointer}
button:hover{background:var(--color-border)}
`;

/** Full srcDoc for the sandboxed iframe. Theme values come from the host; the script reports height and relays sendPrompt. */
export function buildVisualDoc(code: string, vars: Record<string, string>, id: string): string {
  const root = Object.entries(vars).filter(([, value]) => value).map(([key, value]) => `${key}:${value.replace(/[<>;{}]/g, "")}`).join(";");
  const bridge = `(function(){var id=${JSON.stringify(id)};function h(){return Math.ceil(document.documentElement.getBoundingClientRect().height)}function post(){parent.postMessage({type:"visual-height",id:id,height:h()},"*")}window.sendPrompt=function(t){parent.postMessage({type:"visual-send",id:id,text:String(t).slice(0,2000)},"*")};if(window.ResizeObserver)new ResizeObserver(post).observe(document.documentElement);window.addEventListener("load",post);post()})();`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}"><style>:root{${root}}${BASE_CSS}</style></head><body>${code}<script>${bridge}</script></body></html>`;
}
