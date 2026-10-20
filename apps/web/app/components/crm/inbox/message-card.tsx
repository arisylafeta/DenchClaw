"use client";

import { useId, useState } from "react";
import { ChevronDown } from "lucide-react";
import { SenderAvatar } from "../sender-avatar";
import { formatAbsoluteDate, formatRelativeDate } from "../format-relative-date";
import { MessageBody } from "./message-body";
import { AttachmentStrip } from "./attachment-strip";
import { participantLabel, type Participant } from "./participant-chips";
import type { Message } from "./types";
import styles from "./mail.module.css";

const EXCEPTION_TYPES: Record<string, boolean> = { Marketing:true, Transactional:true, Notification:true, "Mailing List":true, Automated:true };

/** Flat, divided message row; older messages remain a single-line disclosure. */
export function MessageCard({ message, people, defaultExpanded, onOpenPerson }: {
  message: Message;
  people: Map<string, Participant>;
  defaultExpanded: boolean;
  onOpenPerson?: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const panelId = useId();
  const sender = message.from_person_id ? people.get(message.from_person_id) : null;
  const self = message.is_self || sender?.is_self;
  const email = message.from_email ?? sender?.email ?? null;
  const name = self ? "You" : sender?.name ?? message.from_name ?? email ?? "Unknown sender";
  const avatarName = self ? email?.split("@")[0] : sender?.name ?? message.from_name ?? email;
  const recipients = [
    { label: "To", people: (message.to_person_ids ?? []).map((id) => people.get(id)).filter((person): person is Participant => Boolean(person)) },
    { label: "Cc", people: (message.cc_person_ids ?? []).map((id) => people.get(id)).filter((person): person is Participant => Boolean(person)) },
  ];
  const observations = (message.direction === "outbound" || self)
    ? (["delivered", "opened", "clicked", "replied"] as const).flatMap((kind) => {
      const at = message[`${kind}_at`] ?? message.events?.find((event) => event.type === kind)?.occurred_at;
      return at ? [{ kind, at }] : [];
    }) : [];

  return <article className={styles.message} data-message-expanded={expanded}>
    <button type="button" className={styles.messageHeading} aria-expanded={expanded} aria-controls={panelId} onClick={() => setExpanded((current) => !current)}>
      <SenderAvatar avatarUrl={sender?.avatar_url} name={avatarName} email={email} seed={email ?? message.id} size="sm" className="!h-[18px] !w-[18px] !text-[9px]" />
      <span className={styles.messageSender} title={email ?? undefined}>{name}</span>
      {!self && message.sender_type && EXCEPTION_TYPES[message.sender_type] && <span className={styles.messageStatus}>{message.sender_type}</span>}
      {expanded && email && <span className="min-w-0 truncate text-[11px]" style={{ color: "var(--color-text-muted)" }}>{email}</span>}
      {!expanded && <span className={styles.messagePreview}>{message.preview?.trim() || "(empty body)"}</span>}
      <time className={styles.messageTime} dateTime={message.sent_at ?? undefined} title={message.sent_at ? formatAbsoluteDate(message.sent_at) : undefined}>{message.sent_at && formatRelativeDate(message.sent_at)}</time>
      <ChevronDown size={13} aria-hidden className={`shrink-0 transition-transform ${expanded ? "rotate-180" : ""}`} style={{ color: "var(--color-text-muted)" }} />
    </button>
    {expanded && <div id={panelId} className={styles.messagePanel}>
      {(recipients.some((group) => group.people.length) || message.to_emails?.length) && <div className={styles.messageRecipients}>
        {recipients.map((group) => group.people.length > 0 && <span key={group.label}>{group.label}: {group.people.map((person, index) => <span key={person.id}>{index > 0 && ", "}{onOpenPerson && !person.is_self && person.id !== person.email
          ? <button type="button" className="hover:underline" title={person.email ?? undefined} onClick={() => onOpenPerson(person.id)}>{participantLabel(person)}</button>
          : <span title={person.email ?? undefined}>{participantLabel(person)}</span>}</span>)}</span>)}
        {!recipients[0].people.length && message.to_emails?.length ? <span>To: {message.to_emails.join(", ")}</span> : null}
      </div>}
      {observations.length > 0 && <div className={styles.messageStatuses} aria-label="Delivery tracking">{observations.map(({kind, at}) => <span key={kind} className={styles.messageStatus} title={formatAbsoluteDate(at)}>{kind[0].toUpperCase() + kind.slice(1)}</span>)}</div>}
      <MessageBody body={message.body} html={message.body_html} preview={message.preview} />
      {message.has_attachments && <AttachmentStrip messageId={message.id} />}
    </div>}
  </article>;
}
