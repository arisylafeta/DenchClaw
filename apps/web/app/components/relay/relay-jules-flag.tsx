"use client";

import { julesChatUrl, julesWords, type JulesReply } from "@/lib/relay-jules-core";
import { waited } from "@/lib/relay-lanes-core";
import { cx } from "./relay-ui";
import j from "./relay-jules-flag.module.css";

/**
 * Marks an email as an answer to a Jules email, and says what Jules made of it: added to the listing, read and not
 * added, not read yet, or passed over. The lanes and the table share it. `compact` keeps to the two chips, with the rest on hover.
 */
export function JulesFlag({ jules, compact }: { jules: JulesReply | null | undefined; compact?: boolean }) {
  if (!jules) return null;
  const words = julesWords(jules, waited(jules.checked_at));
  const url = julesChatUrl(jules.conversation_id);
  return (
    <div className={cx(j.jules, compact && j.compact)} title={compact ? words.line : undefined}>
      <span className={j.chip}>Jules reply</span>
      <span className={cx(j.chip, j[words.tone])}>{words.chip}</span>
      {!compact && url && <a className={j.link} href={url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>Open the chat in Jules ↗</a>}
      {!compact && <span className={j.line}>{words.line}</span>}
    </div>
  );
}
