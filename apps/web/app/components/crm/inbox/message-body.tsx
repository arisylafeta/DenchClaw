"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";

/**
 * Renders a single message body with format detection:
 *
 *   - HTML-shaped content → rendered in a sandboxed iframe via `srcdoc`.
 *     We strip every `<script>` block, every `on*=…` inline event handler,
 *     and every `javascript:` URL from the email HTML before injecting,
 *     then enable `allow-scripts` (without `allow-same-origin`) so a
 *     tiny measurement script we inject inside the iframe can postMessage
 *     its real document height back to the parent. This is the same
 *     pattern Gmail / Outlook web use because parent→child contentDocument
 *     reads are unreliable across sandbox/srcdoc/lazy-load combinations,
 *     while in-iframe self-measurement always works.
 *
 *     Without `allow-same-origin` the iframe lives in an opaque origin,
 *     so even if any malicious markup slipped past sanitization it cannot
 *     reach the parent's cookies/storage/DOM — the only channel out is
 *     `postMessage`, and we filter incoming messages by a per-instance
 *     token to ignore spoofs.
 *
 *   - Plain text / markdown → rendered as preformatted text inside a
 *     scrollable column. We deliberately avoid pulling the workspace's
 *     ReactMarkdown into the email reader because email plain-text rarely
 *     uses markdown syntax intentionally and we don't want subject lines
 *     like "Re: Section 1" to render as a heading.
 *
 * The iframe auto-resizes to its full natural content height — no cap, no
 * internal scrollbar — so the conversation pane is the only scroll surface
 * and the email reads as one continuous document.
 */
export function MessageBody({ body, preview }: { body: string | null; preview: string | null }) {
  const text = body?.trim() || preview?.trim() || "";
  const isHtml = useMemo(() => looksLikeHtml(text), [text]);

  if (!text) {
    return (
      <p
        className="text-[13px] italic"
        style={{
          color: "var(--color-text-muted)",
          fontFamily: '"Bookerly", Georgia, "Times New Roman", serif',
        }}
      >
        (empty body)
      </p>
    );
  }

  if (isHtml) {
    return <SandboxedHtmlBody html={text} />;
  }

  return (
    <div
      className="text-[14px] leading-[1.65] whitespace-pre-wrap break-words"
      style={{
        color: "var(--color-text)",
        fontFamily: '"Bookerly", Georgia, "Times New Roman", serif',
      }}
    >
      {text}
    </div>
  );
}

// ---------------------------------------------------------------------------
// HTML detection
// ---------------------------------------------------------------------------

function looksLikeHtml(input: string): boolean {
  if (!input) {return false;}
  // Cheap structural sniff. We deliberately match on opening tags,
  // doctype, or any closing tag — covers everything from a full
  // <html><body>… document down to a tiny snippet like "<p>hi</p>".
  return /<!doctype|<html|<body|<head|<table|<div|<p\b|<a\s|<br\s*\/?>|<img\s|<\/[a-z]/i.test(input);
}

// ---------------------------------------------------------------------------
// Sandboxed iframe
// ---------------------------------------------------------------------------

function SandboxedHtmlBody({ html }: { html: string }) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [height, setHeight] = useState<number>(160);

  // Per-instance token. The in-iframe measurement script tags every
  // postMessage with this token, and the parent listener only accepts
  // matching messages — so two open emails on the page never confuse
  // each other's heights.
  const reactId = useId();
  const token = useMemo(
    () => reactId.replace(/[^a-zA-Z0-9_-]/g, "") || "iframe",
    [reactId],
  );

  const srcdoc = useMemo(() => buildSrcdoc(html, token), [html, token]);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) {return;}
    const onMessage = (event: MessageEvent) => {
      // Only accept messages from THIS iframe's window — not from any
      // other iframe / extension / parent that happens to broadcast.
      if (event.source !== iframe.contentWindow) {return;}
      const data = event.data as { type?: unknown; token?: unknown; height?: unknown } | null;
      if (
        !data ||
        typeof data !== "object" ||
        data.type !== "denchclaw_email_height" ||
        data.token !== token
      ) {
        return;
      }
      const reported = Number(data.height);
      if (!Number.isFinite(reported)) {return;}
      // No padding added here on purpose — any added pixels would feed
      // back into the next measurement (clientHeight grows with the
      // iframe), creating a runaway loop. Breathing room lives inside
      // the iframe body's own padding instead.
      const next = Math.max(60, Math.round(reported));
      setHeight((prev) => (Math.abs(prev - next) > 2 ? next : prev));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [token]);

  return (
    <iframe
      ref={iframeRef}
      title="Email body"
      srcDoc={srcdoc}
      // Sandbox flags:
      //   - `allow-scripts`: required for our injected measurement script
      //     to run and postMessage the height back. Email-supplied JS is
      //     stripped by stripScripts() before the srcdoc is built.
      //   - NO `allow-same-origin`: the iframe lives in an opaque origin,
      //     so even if some script slipped past sanitization it cannot
      //     read the parent's cookies/storage/DOM. The only channel out
      //     is postMessage, which we filter by a per-instance token.
      //   - `allow-popups` + `allow-popups-to-escape-sandbox`: clicks on
      //     `<a target="_blank">` (forced via our `<base>` injection)
      //     open in a real new tab.
      sandbox="allow-popups allow-popups-to-escape-sandbox allow-scripts"
      referrerPolicy="no-referrer"
      style={{
        width: "100%",
        height,
        border: "none",
        background: "var(--color-surface)",
        colorScheme: "light",
        display: "block",
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// HTML sanitization — strips everything that could execute JS in the iframe.
// Belt-and-suspenders alongside the sandbox: even with `allow-scripts`, we
// only want OUR measurement script to actually run.
// ---------------------------------------------------------------------------

function stripScripts(html: string): string {
  let out = html;
  let prev = "";
  // Repeat until stable so nested / split patterns (e.g. `<scr<script>ipt>`)
  // cannot leave executable fragments. Closing tag allows whitespace before `>`.
  while (out !== prev) {
    prev = out;
    out = out
      .replace(/<script\b[^>]*>[\s\S]*?<\/script\b[^>]*>/gi, "")
      .replace(/<script\b[^>]*\/>/gi, "")
      .replace(/<\/?script\b[^>]*>/gi, "");
  }
  prev = "";
  while (out !== prev) {
    prev = out;
    out = out
      .replace(/\s+on[a-z]+\s*=\s*"[^"]*"/gi, "")
      .replace(/\s+on[a-z]+\s*=\s*'[^']*'/gi, "")
      .replace(/\s+on[a-z]+\s*=\s*[^\s>]+/gi, "");
  }
  prev = "";
  while (out !== prev) {
    prev = out;
    out = out.replace(/javascript\s*:/gi, "");
  }
  return out;
}

function buildMeasureScript(token: string): string {
  // Runs INSIDE the iframe. Computes the document's natural height and
  // postMessages it to the parent. Re-runs on every meaningful event:
  // initial paint, every image load (each one), DOMContentLoaded, full
  // load, ResizeObserver mutations, and a backstop polling schedule for
  // slow webfonts / external assets that don't trigger any of the above.
  return `<script>(function(){
var TOKEN = ${JSON.stringify(token)};
function measure(){
  try {
    var b = document.body;
    if (!b) return;
    // CRITICAL: only measure the BODY (content), never the documentElement
    // or window. documentElement.clientHeight / scrollHeight reflect the
    // iframe's CURRENT viewport height, not the document's natural height
    // — using them here creates a feedback loop where every measurement
    // reports the iframe's own grown size and the iframe keeps growing.
    var height = Math.max(b.scrollHeight, b.offsetHeight);
    parent.postMessage({ type: 'denchclaw_email_height', token: TOKEN, height: height }, '*');
  } catch (e) {}
}
function attach(){
  measure();
  try {
    // Observe ONLY the body — observing documentElement would also fire
    // on the viewport resize that we ourselves cause when growing the
    // iframe, contributing to feedback-loop runs.
    if (typeof ResizeObserver !== 'undefined' && document.body) {
      var ro = new ResizeObserver(measure);
      ro.observe(document.body);
    }
  } catch (e) {}
  var imgs = document.images || [];
  for (var i = 0; i < imgs.length; i++) {
    if (!imgs[i].complete) {
      imgs[i].addEventListener('load', measure);
      imgs[i].addEventListener('error', measure);
    }
  }
  var delays = [50, 200, 500, 1000, 2000, 4000, 8000];
  for (var j = 0; j < delays.length; j++) setTimeout(measure, delays[j]);
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', attach);
} else {
  attach();
}
window.addEventListener('load', measure);
})();</script>`;
}

function buildSrcdoc(html: string, token: string): string {
  // Real marketing emails (MJML, Gmail-rendered HTML, etc.) almost always
  // come as a complete HTML document — `<!doctype><html><head><style>…
  // </style></head><body>…</body></html>`. If we naively wrap that inside
  // our own `<html><body>`, the parser treats the nested <html>/<body>
  // tags as invalid and the email's content lands in unexpected places
  // in the DOM (and `body.scrollHeight` reports a tiny value).
  //
  // So: if the body is already a full document, surgically inject our
  // additions (base href + image clamp + measurement script) into its
  // own <head>. Otherwise, wrap the fragment in a styled shell.
  const sanitized = stripScripts(html.trim());
  const isFullDoc = /^\s*(?:<!doctype|<html\b)/i.test(sanitized);
  const measureScript = buildMeasureScript(token);

  if (isFullDoc) {
    // Minimal head injection — we deliberately don't add a base stylesheet
    // because the email ships its own; piling our font/padding on top
    // tends to make marketing layouts look broken.
    const HEAD_INJECT = `<base target="_blank"><style>
  img, video { max-width: 100% !important; height: auto !important; }
  table { max-width: 100%; }
  img[width="1"][height="1"] { display: none !important; }
</style>${measureScript}`;

    const headOpen = sanitized.match(/<head\b[^>]*>/i);
    if (headOpen?.index !== undefined) {
      const cut = headOpen.index + headOpen[0].length;
      return sanitized.slice(0, cut) + HEAD_INJECT + sanitized.slice(cut);
    }
    const htmlOpen = sanitized.match(/<html\b[^>]*>/i);
    if (htmlOpen?.index !== undefined) {
      const cut = htmlOpen.index + htmlOpen[0].length;
      return `${sanitized.slice(0, cut)}<head>${HEAD_INJECT}</head>${sanitized.slice(cut)}`;
    }
    // Doctype-only with no <html> tag — extremely unusual; fall through to wrap.
  }

  // Fragment path: wrap in our editorial shell.
  const STYLE = `
    :root { color-scheme: light; }
    html, body {
      margin: 0;
      padding: 16px 18px;
      background: #ffffff;
      color: #1c1c1a;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
      font-size: 14px;
      line-height: 1.55;
      word-wrap: break-word;
      overflow-wrap: anywhere;
    }
    body * { max-width: 100% !important; }
    img, video { max-width: 100% !important; height: auto !important; }
    table { border-collapse: collapse; max-width: 100% !important; }
    a { color: #687000; text-decoration: underline; }
    blockquote { margin: 0 0 0 8px; padding-left: 12px; border-left: 2px solid rgba(0,0,0,0.12); color: #555; }
    pre, code { font-family: "SF Mono", "Fira Code", monospace; font-size: 13px; }
    pre { white-space: pre-wrap; }
    /* Hide tracking pixels — common 1x1 invisible images. */
    img[width="1"][height="1"] { display: none !important; }
  `.trim();
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<base target="_blank">
<style>${STYLE}</style>
${measureScript}
</head>
<body>${sanitized}</body>
</html>`;
}
