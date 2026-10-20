"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { splitQuotedText } from "./quoted-message";
import { prepareEmail } from "./sanitize-email";
import styles from "./mail.module.css";

/** `ownCopy`: our own prepared draft, so remote images load as the recipient will see them. Received mail keeps images blocked until the reader opts in. */
export function MessageBody({ body, html, preview, ownCopy = false }: { body: string | null; html?: string | null; preview: string | null; ownCopy?: boolean }) {
  const text = body?.trim() || preview?.trim() || "";
  if (html?.trim()) return <SandboxedHtmlBody key={html} html={html} ownCopy={ownCopy} />;
  if (!text) return <p className="text-[13px]" style={{ color: "var(--color-text-muted)" }}>(empty body)</p>;
  return <PlainTextBody text={text} />;
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

function SandboxedHtmlBody({ html, ownCopy }: { html: string; ownCopy: boolean }) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(80);
  const [showQuoted, setShowQuoted] = useState(false);
  const [loadImages, setLoadImages] = useState(ownCopy);
  // DOM parsing is client-only: never inject unsanitised HTML during SSR.
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  const prepared = useMemo(() => ready ? prepareEmail(html, loadImages, showQuoted) : null, [html, loadImages, showQuoted, ready]);

  useEffect(() => {
    const frame = iframeRef.current;
    if (!frame || !prepared) return;
    let observer: ResizeObserver | undefined;
    const measure = () => {
      const body = frame.contentDocument?.body;
      if (body) setHeight(Math.ceil(Math.max(body.scrollHeight, body.getBoundingClientRect().height)) + 2);
    };
    const attach = () => {
      observer?.disconnect();
      const body = frame.contentDocument?.body;
      if (!body) return;
      measure();
      if (typeof ResizeObserver !== "undefined") {
        observer = new ResizeObserver(measure);
        observer.observe(body);
      }
      for (const image of Array.from(body.querySelectorAll("img"))) {
        image.addEventListener("load", measure);
        image.addEventListener("error", measure);
      }
    };
    frame.addEventListener("load", attach);
    window.addEventListener("resize", measure);
    return () => { frame.removeEventListener("load", attach); window.removeEventListener("resize", measure); observer?.disconnect(); };
  }, [prepared]);

  return <div>
    {prepared?.hasRemoteImages && !loadImages && <div className="mb-2 text-xs" style={{ color: "var(--color-text-muted)" }}>Images are hidden to protect privacy. <button type="button" className="underline" onClick={() => setLoadImages(true)}>Load images</button></div>}
    {prepared && <iframe ref={iframeRef} title="Email body" srcDoc={prepared.srcdoc}
      // Same-origin is ONLY for parent-side height measurement. Scripts are disabled
      // twice (sandbox and CSP); no email code ever runs, including measurement code.
      // Popups are needed for normal email links, always noopener/noreferrer.
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer"
      style={{ width: "100%", height, border: "none", background: "#fff", colorScheme: "light", display: "block" }} />}
    {prepared?.hasQuoted && <button type="button" className={styles.quoteToggle} aria-expanded={showQuoted} onClick={() => setShowQuoted((show) => !show)}>{showQuoted ? "Hide quoted text" : "Show quoted text"}</button>}
  </div>;
}
