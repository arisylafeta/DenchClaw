"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { splitQuotedText, hasQuotedHtml } from "./quoted-message";
import styles from "./mail.module.css";

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
  if (!text) {return <p className="text-[13px]" style={{ color: "var(--color-text-muted)" }}>(empty body)</p>;}
  return looksLikeHtml(text) ? <SandboxedHtmlBody html={text} /> : <PlainTextBody text={text} />;
}

function PlainTextBody({ text }: { text: string }) {
  const folded = useMemo(() => splitQuotedText(text), [text]);
  const [showQuoted, setShowQuoted] = useState(false);
  return <div>
    {folded.visible && <div className={styles.messageText}>{folded.visible}</div>}
    {folded.hidden && <>
      <button type="button" className={styles.quoteToggle} aria-expanded={showQuoted} onClick={() => setShowQuoted((show) => !show)}>{showQuoted ? "Hide quoted text" : "Show quoted text"}</button>
      {showQuoted && <div className={`${styles.messageText} ${styles.quotedText}`}>{folded.hidden}</div>}
    </>}
  </div>;
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
  const [showQuoted, setShowQuoted] = useState(false);
  const hasQuoted = hasQuotedHtml(html);

  // Per-instance token. The in-iframe measurement script tags every
  // postMessage with this token, and the parent listener only accepts
  // matching messages — so two open emails on the page never confuse
  // each other's heights.
  const reactId = useId();
  const token = useMemo(
    () => reactId.replace(/[^a-zA-Z0-9_-]/g, "") || "iframe",
    [reactId],
  );

  const srcdoc = useMemo(() => buildSrcdoc(html, token, showQuoted), [html, token, showQuoted]);

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

  return <div>
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
    {hasQuoted && <button type="button" className={styles.quoteToggle} aria-expanded={showQuoted} onClick={() => setShowQuoted((show) => !show)}>{showQuoted ? "Hide quoted text" : "Show quoted text"}</button>}
  </div>;
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

export function buildSrcdoc(html: string, token: string, showQuoted = false): string {
  // Preserve the existing sanitizer and opaque-origin sandbox. Only our height script executes.
  const sanitized = stripScripts(html.trim());
  const style = `
    :root { color-scheme: light; }
    html, body { margin:0!important; padding:0!important; min-height:0!important; background:#fff; color:#1a1a1a; overflow-wrap:anywhere; }
    body, body p, body div, body span, body td, body a, body li {
      font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif!important;
      font-size:14px!important; line-height:1.55!important;
    }
    p { margin:0 0 10px!important; }
    img, video { max-width:100%!important; height:auto!important; }
    table { max-width:100%; }
    a { color:#1e40af; }
    pre, code { font-family:monospace!important; font-size:13px!important; white-space:pre-wrap; }
    img[width="1"][height="1"] { display:none!important; }
    ${showQuoted ? "" : "html body blockquote, html body .gmail_quote, html body .gmail_signature, html body #divRplyFwdMsg, html body .OutlookMessageHeader { display:none!important; }"}
  `;
  const inject = `<base target="_blank"><style>${style}</style>${buildMeasureScript(token)}`;
  const headClose = sanitized.match(/<\/head\s*>/i);
  if (headClose?.index !== undefined) {
    return sanitized.slice(0, headClose.index) + inject + sanitized.slice(headClose.index);
  }
  const headOpen = sanitized.match(/<head\b[^>]*>/i);
  if (headOpen?.index !== undefined) {
    const cut = headOpen.index + headOpen[0].length;
    return sanitized.slice(0, cut) + inject + sanitized.slice(cut);
  }
  const htmlOpen = sanitized.match(/<html\b[^>]*>/i);
  if (htmlOpen?.index !== undefined) {
    const cut = htmlOpen.index + htmlOpen[0].length;
    return `${sanitized.slice(0, cut)}<head>${inject}</head>${sanitized.slice(cut)}`;
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${inject}</head><body>${sanitized}</body></html>`;
}
