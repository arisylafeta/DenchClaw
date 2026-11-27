/**
 * Jules stats metrics (REB-727). Pure transforms over production rows; no IO, so the
 * funnel, health and lane definitions are unit-testable and the page only renders.
 *
 * Counts and states only: nothing here keeps a seller's name, email or message body
 * beyond the in-memory check that produces a count.
 */

export type Lane = "sales" | "recycling" | "buyer";
export type EntryKey = "sell" | "recycle" | "home" | "dashboard" | "buyer" | "directory" | "other";

export type RawSession = {
  id: string;
  source_surface: string | null;
  created_at: string;
  contact_email: string | null;
  account_id: string | null;
  created_by_user_id: string | null;
  owner_auth_user_id: string | null;
};

export type RawLead = {
  conversation_id: string | null;
  channel_mode: string | null;
  stage: string | null;
  contact_email: string | null;
  ready_to_publish: boolean | null;
  listing_status: string | null;
  first_seen_at: string | null;
  discarded_at: string | null;
};

export type RawEvent = {
  conversation_id: string | null;
  kind: string;
  at: string;
};

export type RawMessage = {
  session_id: string;
  role: string;
  created_at: string;
  body: string | null;
};

export type RawTurnError = {
  session_id: string | null;
  emitted_at: string;
};

export type MailActivity = {
  email: string;
  lastInboundAt: string | null;
  /** Subject of the newest inbound mail: notification subjects are not a person waiting. */
  lastSubject?: string | null;
  lastOutboundAt: string | null;
  /** Our first mail to the address: anything inbound older than this predates the lead. */
  firstOutboundAt?: string | null;
  /** Newest reply from a founder mailbox (Alex or Ari answered this person by hand). */
  handAnsweredAt?: string | null;
  /** Agent profile that owns the newest inbound thread, when one does. */
  threadOwner?: string | null;
};

export type WindowInput = {
  now: Date;
  sessions: RawSession[];
  leads: RawLead[];
  events: RawEvent[];
  messages: RawMessage[];
  turnErrors: RawTurnError[];
  /** Emails with activity in our mail log: last inbound and last outbound we sent. */
  mail: MailActivity[];
};

export type FunnelRow = {
  entry: EntryKey;
  label: string;
  chats: number;
  priceShown: number;
  emailLeft: number;
  readyToPublish: number;
  published: number;
};

export type WindowStats = {
  from: string;
  to: string;
  funnel: FunnelRow[];
  totals: Omit<FunnelRow, "entry" | "label">;
  followUps: { teamEmails: number; autoFollowUps: number; sellerReplies: number };
  lanes: { sales: number; recycling: number; buyer: number };
  health: HealthStats;
};

export type HealthStats = {
  noReply: number;
  placeholderReplies: number;
  failedTurns: number;
  firstReplySeconds: { p50: number | null; p90: number | null; answered: number };
  waitingOnUs: number;
};

export type JulesStats = {
  generatedAt: string;
  current: WindowStats;
  previous: WindowStats;
};

const ENTRY_LABELS: Record<EntryKey, string> = {
  sell: "Sell card",
  recycle: "Recycle card",
  home: "Homepage",
  dashboard: "Dashboard",
  buyer: "Buyer page",
  directory: "Recycler directory",
  other: "Other",
};

const ENTRY_ORDER: EntryKey[] = ["sell", "recycle", "home", "dashboard", "buyer", "directory", "other"];

const RECYCLING_SURFACES = new Set(["recycle-batteries", "recycler-directory"]);
const STUB_REPLY = "I've started your draft listing.";
const INTERNAL_EMAIL = /(@rebattery\.io|@qa\.rebattery\.io)$|^qa[+-]/i;
/** Account used by staff for manual testing; never a seller lead. */
const STAFF_ACCOUNT = "c45a4168-88ab-43e4-9d22-6ae46298cef8";
/** The profile that owns Jules's own mail threads; any other owner answers the person. */
const JULES_THREAD_OWNER = "papajules";
/** Marketplace and site notifications: a machine wrote them, not a person waiting for us. */
const NOTIFICATION_SUBJECTS = [
  "new message about",
  "counter offer received",
  "new buy now transaction",
  "your shop quality report",
  "new offer received",
  "your listing",
];
/** The platform's own first-contact emails: they start our side of the conversation. */
const CONTACT_EVENT_KINDS = new Set(["received_email_sent", "finish_email_sent", "follow_up_sent", "team_email_sent"]);
/** The app-written timeline row from estimate_battery_value (lib/db/jules/price-shown.ts). */
const PRICE_EVENT_KIND = "price_shown";

export function entryKey(sourceSurface: string | null, signedIn: boolean): EntryKey {
  const surface = (sourceSurface ?? "").toLowerCase();
  if (surface === "sell-batteries") {
    return "sell";
  }
  if (surface === "recycle-batteries") {
    return "recycle";
  }
  if (surface === "home") {
    return "home";
  }
  if (surface === "buy-batteries" || surface === "buyer-batteries") {
    return "buyer";
  }
  if (surface === "recycler-directory") {
    return "directory";
  }
  // A session with no page attribution is a signed-in dashboard chat when the visitor
  // was authenticated, otherwise the entry page was lost.
  return signedIn ? "dashboard" : "other";
}

export function laneOf(session: RawSession, recyclingLead: boolean): Lane {
  const surface = (session.source_surface ?? "").toLowerCase();
  if (RECYCLING_SURFACES.has(surface) || recyclingLead) {
    return "recycling";
  }
  if (surface === "buy-batteries" || surface === "buyer-batteries") {
    return "buyer";
  }
  return "sales";
}

/** A reply showing a price: a currency symbol or code followed by an amount. */
export function showsPrice(body: string | null): boolean {
  if (!body) {
    return false;
  }
  return /(?:[£€$]\s?\d)|(?:\b\d[\d,.]*\s?(?:gbp|eur|usd)\b)/i.test(body);
}

export function isPlaceholderReply(body: string | null): boolean {
  const text = (body ?? "").replace(/\u2019/g, "'").trim().replace(/\s+/g, " ");
  return text.length === 0 || text === STUB_REPLY;
}

function emailOf(session: RawSession, leads: RawLead[]): string | null {
  const own = (session.contact_email ?? "").trim().toLowerCase();
  if (own) {
    return own;
  }
  for (const lead of leads) {
    const value = (lead.contact_email ?? "").trim().toLowerCase();
    if (value) {
      return value;
    }
  }
  return null;
}

function isIncluded(session: RawSession, leads: RawLead[]): boolean {
  const surface = (session.source_surface ?? "").toLowerCase();
  if (surface.startsWith("reb308")) {
    return false;
  }
  if (session.account_id === STAFF_ACCOUNT) {
    return false;
  }
  const email = emailOf(session, leads);
  return !(email && INTERNAL_EMAIL.test(email));
}

function isReachable(session: RawSession, leads: RawLead[]): boolean {
  if (emailOf(session, leads)) {
    return true;
  }
  return Boolean(session.account_id || session.owner_auth_user_id);
}

function isReady(leads: RawLead[]): boolean {
  return leads.some(
    (lead) =>
      !lead.discarded_at &&
      (lead.ready_to_publish === true ||
        (lead.stage !== null && ["ready", "submitted", "live", "sold"].includes(lead.stage))),
  );
}

function isPublished(leads: RawLead[]): boolean {
  return leads.some(
    (lead) =>
      !lead.discarded_at &&
      ((lead.stage !== null && ["live", "sold"].includes(lead.stage)) || lead.listing_status === "published"),
  );
}

export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) {
    return null;
  }
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) {
    return Math.round(sorted[lower] * 10) / 10;
  }
  const value = sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
  return Math.round(value * 10) / 10;
}

export function buildWindow(
  input: Omit<WindowInput, "now">,
  from: Date,
  to: Date,
  waitingOnUs: number,
): WindowStats {
  const fromMs = from.getTime();
  const toMs = to.getTime();
  const inWindow = (value: string | null | undefined): boolean => {
    if (!value) {
      return false;
    }
    const ms = new Date(value).getTime();
    return ms >= fromMs && ms < toMs;
  };

  const leadsByConversation = new Map<string, RawLead[]>();
  for (const lead of input.leads) {
    if (!lead.conversation_id) {
      continue;
    }
    const list = leadsByConversation.get(lead.conversation_id) ?? [];
    list.push(lead);
    leadsByConversation.set(lead.conversation_id, list);
  }

  const messagesBySession = new Map<string, RawMessage[]>();
  for (const message of input.messages) {
    const list = messagesBySession.get(message.session_id) ?? [];
    list.push(message);
    messagesBySession.set(message.session_id, list);
  }

  const sessions = input.sessions.filter((session) => inWindow(session.created_at));
  const rows = new Map<EntryKey, FunnelRow>();
  for (const key of ENTRY_ORDER) {
    rows.set(key, {
      entry: key,
      label: ENTRY_LABELS[key],
      chats: 0,
      priceShown: 0,
      emailLeft: 0,
      readyToPublish: 0,
      published: 0,
    });
  }

  const lanes = { sales: 0, recycling: 0, buyer: 0 };
  const sessionIds = new Set<string>();
  // Staff, QA and smoke-test chats are dropped everywhere, including their events.
  const excludedSessions = new Set<string>();
  for (const session of input.sessions) {
    if (!isIncluded(session, leadsByConversation.get(session.id) ?? [])) {
      excludedSessions.add(session.id);
    }
  }

  for (const session of sessions) {
    const leads = leadsByConversation.get(session.id) ?? [];
    if (!isIncluded(session, leads)) {
      continue;
    }
    sessionIds.add(session.id);
    const entry = entryKey(
      session.source_surface,
      Boolean(session.account_id || session.owner_auth_user_id || session.created_by_user_id),
    );
    const row = rows.get(entry)!;
    row.chats += 1;
    const lane = laneOf(session, leads.some((lead) => lead.channel_mode === "recycling"));
    lanes[lane] += 1;

    const messages = messagesBySession.get(session.id) ?? [];
    // Buyer chats quote marketplace prices; only a seller-lane valuation counts here. The
    // recorded `price_shown` event is the fact; the reply text only covers chats that ran
    // before the event existed.
    if (lane !== "buyer" && priceWasShown(session.id, messages, input.events, inWindow)) {
      row.priceShown += 1;
    }
    if (isReachable(session, leads)) {
      row.emailLeft += 1;
    }
    if (isReady(leads)) {
      row.readyToPublish += 1;
    }
    if (isPublished(leads)) {
      row.published += 1;
    }

  }

  const funnel = ENTRY_ORDER.map((key) => rows.get(key)!).filter((row) => row.chats > 0);
  const totals = funnel.reduce(
    (acc, row) => ({
      chats: acc.chats + row.chats,
      priceShown: acc.priceShown + row.priceShown,
      emailLeft: acc.emailLeft + row.emailLeft,
      readyToPublish: acc.readyToPublish + row.readyToPublish,
      published: acc.published + row.published,
    }),
    { chats: 0, priceShown: 0, emailLeft: 0, readyToPublish: 0, published: 0 },
  );

  let teamEmails = 0;
  let autoFollowUps = 0;
  let sellerReplies = 0;
  for (const event of input.events) {
    if (!inWindow(event.at)) {
      continue;
    }
    if (event.conversation_id && excludedSessions.has(event.conversation_id)) {
      continue;
    }
    if (event.kind === "team_email_sent") {
      teamEmails += 1;
    } else if (event.kind === "follow_up_sent") {
      autoFollowUps += 1;
    } else if (event.kind === "seller_email_reply") {
      sellerReplies += 1;
    }
  }

  let noReply = 0;
  let placeholderReplies = 0;
  const firstReplySeconds: number[] = [];
  for (const session of sessions) {
    if (!sessionIds.has(session.id)) {
      continue;
    }
    const messages = (messagesBySession.get(session.id) ?? []).toSorted(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    );
    const firstUser = messages.find((message) => message.role === "user");
    if (!firstUser) {
      continue;
    }
    const firstReply = messages.find(
      (message) =>
        message.role === "assistant" &&
        new Date(message.created_at).getTime() >= new Date(firstUser.created_at).getTime(),
    );
    if (!firstReply) {
      noReply += 1;
      continue;
    }
    const asked = new Date(firstUser.created_at).getTime();
    const replied = new Date(firstReply.created_at).getTime();
    if (Number.isFinite(asked) && Number.isFinite(replied) && replied >= asked) {
      firstReplySeconds.push((replied - asked) / 1000);
    }
  }
  for (const message of input.messages) {
    if (message.role !== "assistant" || !inWindow(message.created_at)) {
      continue;
    }
    if (!sessionIds.has(message.session_id)) {
      continue;
    }
    if (isPlaceholderReply(message.body)) {
      placeholderReplies += 1;
    }
  }

  const failedTurns = input.turnErrors.filter(
    (error) => inWindow(error.emitted_at) && !(error.session_id && excludedSessions.has(error.session_id)),
  ).length;
  const sorted = firstReplySeconds.toSorted((a, b) => a - b);

  return {
    from: from.toISOString(),
    to: to.toISOString(),
    funnel,
    totals,
    followUps: { teamEmails, autoFollowUps, sellerReplies },
    lanes,
    health: {
      noReply,
      placeholderReplies,
      failedTurns,
      firstReplySeconds: {
        p50: percentile(sorted, 0.5),
        p90: percentile(sorted, 0.9),
        answered: sorted.length,
      },
      waitingOnUs,
    },
  };
}

/** Notification subjects arrive with re:/fw: prefixes; compare the subject itself. */
export function isNotificationSubject(subject: string | null | undefined): boolean {
  let text = (subject ?? "").trim().toLowerCase();
  while (text.startsWith("re:") || text.startsWith("fw:") || text.startsWith("fwd:")) {
    text = text.split(":").slice(1).join(":").trim();
  }
  return NOTIFICATION_SUBJECTS.some((prefix) => text.startsWith(prefix));
}

/**
 * People waiting on us, using the same rules as `scripts/jules_waiting_on_us.py`: the
 * newest inbound mail is later than our newest mail to them, and it is not a marketplace
 * or site notification, not a thread another agent owns, not already answered by hand
 * from Alex's or Ari's mailbox, and not mail that predates our first contact.
 */
export function countWaitingOnUs(
  mail: MailActivity[],
  emails: string[],
  contact: ContactTimes = { platformEmail: new Map(), firstChat: new Map() },
): number {
  const wanted = new Set(emails.filter(Boolean));
  const seen = new Set<string>();
  let waiting = 0;
  for (const row of mail) {
    const email = (row.email ?? "").toLowerCase();
    if (!email || !wanted.has(email) || seen.has(email)) {
      continue;
    }
    seen.add(email);
    if (!row.lastInboundAt) {
      continue;
    }
    if (row.lastOutboundAt && new Date(row.lastInboundAt) <= new Date(row.lastOutboundAt)) {
      continue;
    }
    if (isNotificationSubject(row.lastSubject)) {
      continue;
    }
    if (row.threadOwner && row.threadOwner !== JULES_THREAD_OWNER) {
      continue;
    }
    if (row.handAnsweredAt && new Date(row.handAnsweredAt) >= new Date(row.lastInboundAt)) {
      continue;
    }
    // First contact is the earliest of our first mail and the platform's first automatic
    // email. With neither, before their first chat is still not this lead waiting.
    const firstContact = [row.firstOutboundAt, contact.platformEmail.get(email)]
      .filter((value): value is string => Boolean(value))
      .reduce<string | null>((earliest, value) => (!earliest || new Date(value) < new Date(earliest) ? value : earliest), null);
    if (firstContact && new Date(row.lastInboundAt) < new Date(firstContact)) {
      continue;
    }
    const started = contact.firstChat.get(email);
    if (!row.firstOutboundAt && started && new Date(row.lastInboundAt) < new Date(started)) {
      continue;
    }
    waiting += 1;
  }
  return waiting;
}

/** A chat showed a price: the recorded event, or the reply text for chats older than it. */
function priceWasShown(
  sessionId: string,
  messages: RawMessage[],
  events: RawEvent[],
  inWindow: (value: string | null | undefined) => boolean,
): boolean {
  if (events.some((event) => event.conversation_id === sessionId && event.kind === PRICE_EVENT_KIND && inWindow(event.at))) {
    return true;
  }
  return messages.some((message) => message.role === "assistant" && showsPrice(message.body));
}

export type ContactTimes = {
  /** The platform's first automatic email (received, finish link, follow-up, team email) per address. */
  platformEmail: Map<string, string>;
  /** The person's first Jules chat per address. */
  firstChat: Map<string, string>;
};

/** When our side of the conversation started, per lead email, as the script computes it. */
export function contactTimes(input: Omit<WindowInput, "now">): ContactTimes {
  const leadsByConversation = new Map<string, RawLead[]>();
  for (const lead of input.leads) {
    if (!lead.conversation_id) {
      continue;
    }
    const list = leadsByConversation.get(lead.conversation_id) ?? [];
    list.push(lead);
    leadsByConversation.set(lead.conversation_id, list);
  }
  const platformEmail = new Map<string, string>();
  const firstChat = new Map<string, string>();
  const remember = (into: Map<string, string>, email: string | null, at: string | null | undefined) => {
    const key = (email ?? "").trim().toLowerCase();
    if (!key || !at) {
      return;
    }
    const current = into.get(key);
    if (!current || new Date(at) < new Date(current)) {
      into.set(key, at);
    }
  };
  const emailByConversation = new Map<string, string>();
  for (const session of input.sessions) {
    const email = emailOf(session, leadsByConversation.get(session.id) ?? []);
    remember(firstChat, email, session.created_at);
    if (email) {
      emailByConversation.set(session.id, email);
    }
  }
  for (const event of input.events) {
    if (!CONTACT_EVENT_KINDS.has(event.kind) || !event.conversation_id) {
      continue;
    }
    remember(platformEmail, emailByConversation.get(event.conversation_id) ?? null, event.at);
  }
  return { platformEmail, firstChat };
}

/** Lead emails the page needs for the waiting-on-us join, newest first, de-duplicated. */
export function leadEmails(input: Omit<WindowInput, "now">): string[] {
  const leadsByConversation = new Map<string, RawLead[]>();
  for (const lead of input.leads) {
    if (!lead.conversation_id) {
      continue;
    }
    const list = leadsByConversation.get(lead.conversation_id) ?? [];
    list.push(lead);
    leadsByConversation.set(lead.conversation_id, list);
  }
  const emails = new Set<string>();
  for (const session of input.sessions) {
    const leads = leadsByConversation.get(session.id) ?? [];
    if (!isIncluded(session, leads)) {
      continue;
    }
    if (laneOf(session, leads.some((lead) => lead.channel_mode === "recycling")) !== "sales") {
      continue;
    }
    const email = emailOf(session, leads);
    if (email) {
      emails.add(email);
    }
  }
  return [...emails];
}

export function buildJulesStats(input: WindowInput): JulesStats {
  const now = input.now;
  const currentFrom = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
  const previousFrom = new Date(now.getTime() - 14 * 24 * 3600 * 1000);
  const waitingOnUs = countWaitingOnUs(input.mail, leadEmails(input), contactTimes(input));
  return {
    generatedAt: now.toISOString(),
    current: buildWindow(input, currentFrom, now, waitingOnUs),
    previous: buildWindow(input, previousFrom, currentFrom, waitingOnUs),
  };
}
