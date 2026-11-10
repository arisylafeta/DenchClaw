/** Relay lead cards, the pure part: what a first reply to a new seller or buyer asks for, and how the reply is put
 * together. No sentence in the reply is written by the model. It is a greeting, a fixed thanks line, Alex's own answers
 * to what they asked (picked or typed once, then used word for word), one fixed bullet per deal fact still missing, and
 * the close. The model only reads their email into facts and questions, and `verifyLead` keeps a fact or a question
 * only when its quote is found in the email. The ask list follows Matcha's intake reference (the bulk deal playbook). */

export type LeadSide = "seller" | "buyer";
export type LeadUnit = "cells" | "modules" | "packs";
export type LeadRole = "owner" | "broker" | "unknown";
export type LeadFact = { key: string; value: string };
/** A standard question they asked (non-exclusive, buyers in a region, how we work, pricing, collection). */
export type LeadAsked = { topic: string; region: string | null; quote: string };
/** Any other question they asked, in their own words. Only Alex can answer it. */
export type LeadOther = { id: string; quote: string };
export type LeadEmail = { subject: string; text: string; at: string; files: string[] };

export type LeadData = {
  side: LeadSide;
  unit: LeadUnit;
  role: LeadRole;
  firstName: string | null;
  summary: string;
  facts: LeadFact[];
  asked: LeadAsked[];
  other: LeadOther[];
  /** Ask keys already covered: by their email or by the linked deal. */
  have: string[];
  /** What came attached, for the thanks line. */
  sent: "photos" | "files" | null;
  deal: boolean;
  email: LeadEmail;
};

/** text null: Alex chose to leave the question out of this reply. */
export type LeadPick = { text: string | null; remember?: boolean };
export type LeadState = { off: string[]; picks: Record<string, LeadPick>; reopened: string[] };
export const EMPTY_STATE: LeadState = { off: [], picks: {}, reopened: [] };

export type LeadAsk = { key: string; label: string; on: boolean; card: boolean };
export type LeadOption = { label: string; line: string };
export type LeadSpan = { text: string; answer?: { id: string; saved: boolean } };
export type LeadBlock =
  | { kind: "para"; spans: LeadSpan[] }
  | { kind: "question"; id: string; prompt: string; quote: string; options: LeadOption[]; remember: boolean }
  | { kind: "asks"; intro: string; bullets: string[] };
export type LeadReply = {
  blocks: LeadBlock[];
  /** The email text as it would be sent now; unanswered questions are left out of it. */
  body: string;
  /** Blue questions still unanswered. Send waits for these. */
  open: string[];
  asks: LeadAsk[];
  cover: { text: string; tone: "ok" | "warn" };
};

type AskDef = { key: string; label: string; bullet?: string; doc?: string; card?: boolean };

const ONE: Record<LeadUnit, string> = { cells: "cell", modules: "module", packs: "pack" };

/** What a first reply asks for, in order. `card` marks the facts the deal cannot go to the other side without. */
export function asksFor(side: LeadSide, unit: LeadUnit, role: LeadRole): AskDef[] {
  const one = ONE[unit];
  if (side === "buyer") {
    return [
      { key: "what", label: "What they need", bullet: "What you need: maker, model or chemistry", card: true },
      { key: "how_many", label: "Quantity", bullet: "How many, or how many kWh", card: true },
      { key: "price", label: "Target price", bullet: "Your target price, and per what (pack, module, cell or kWh)", card: true },
      { key: "when", label: "Needed by", bullet: "When you need them by", card: true },
      { key: "where", label: "Delivery country", bullet: "The delivery country", card: true },
      { key: "min_health", label: "Minimum health", bullet: "The minimum health you would accept" },
      { key: "tests", label: "Tests needed", bullet: "Any tests or documents you need" },
    ];
  }
  const price = `${role === "broker" ? "The owner's" : "Your"} asking price, per ${one} or per kWh`;
  if (unit === "packs") {
    return [
      { key: "owner", label: "Owner", bullet: "Who owns the packs", card: true },
      { key: "what", label: "Make, model", bullet: "The make, model and kWh of the packs", card: true },
      { key: "how_many", label: "Quantity", bullet: "How many there are", card: true },
      { key: "price", label: "Price", bullet: price, card: true },
      { key: "where", label: "Location", bullet: "Where they are", card: true },
      { key: "health", label: "Health per pack", bullet: "A health reading per pack, or which ones are untested", card: true },
      { key: "when", label: "Clear-by date", bullet: "When they need to go", card: true },
      { key: "state", label: "In the car or out", bullet: "Whether they are in the car or out, and any damage" },
      { key: "docs", label: "Health list, photos", doc: "the health list with tag or VIN, and photos of the labels" },
    ];
  }
  return [
    { key: "owner", label: "Owner", bullet: "Who the owner is", card: true },
    { key: "what", label: "Maker, model", bullet: "The maker, model and chemistry", card: true },
    { key: "how_many", label: "Quantity", bullet: "How many there are", card: true },
    { key: "price", label: "Price", bullet: price, card: true },
    { key: "where", label: "Location", bullet: "Where they are", card: true },
    { key: "health", label: `Health per ${one}`, bullet: `Health per ${one}, or which ones are untested`, card: true },
    { key: "when", label: "Clear-by date", bullet: "When the lot needs to be cleared", card: true },
    { key: "storage", label: "Storage", bullet: "How they have been stored, and their charge level" },
    { key: "un38", label: "UN38.3", bullet: "The UN38.3 summary, and how they will be packed" },
    { key: "docs", label: "Datasheet, tests", doc: "the datasheet and any test reports with their dates" },
  ];
}

/** Every fact key the reader may return, with what counts as having it. */
export const FACT_KEYS: Record<string, string> = {
  owner: "who owns the stock: the sender says it is theirs, or names the owner (not just \"the owner\")",
  what: "the maker and model, or the chemistry and format",
  how_many: "the size of the whole lot or order: a count of units, or its total kWh or MWh (never the size of one unit)",
  price: "a price or budget, with its unit",
  where: "where the stock is, or (buyer) the delivery country",
  condition: "new, used, tested, operational, damaged",
  health: "a health reading, cycle count or test result",
  when: "a date or deadline: when it must go, or (buyer) needed by",
  storage: "how it is stored, or its charge level",
  un38: "a UN38.3 summary or packing details",
  docs: "a datasheet, test report or health list is attached or linked",
  split: "whole lot only, or can be split",
  state: "packs: still in the car or out, any damage",
  min_health: "buyer: the minimum health they accept",
  tests: "buyer: the tests or documents they need",
};
const CHIP_ORDER = ["what", "how_many", "where", "price", "condition", "health", "when", "split", "owner"];

export const REGIONS: Record<string, string> = {
  north_america: "North America", europe: "Europe", uk: "the UK", asia: "Asia", middle_east: "the Middle East",
  africa: "Africa", south_america: "South America", australia: "Australia",
};

type Topic = { sides: LeadSide[]; prompt: (name: string, region: string) => string; options: (region: string) => LeadOption[]; remember: boolean };

/** The questions leads keep asking. The options are starting wordings: nothing is used until Alex picks or types one,
 * and his choice is what is saved. Seller pricing has no question: the rule is fixed (never offer a seller a price). */
const TOPICS: Record<string, Topic> = {
  non_exclusive: {
    sides: ["seller", "buyer"], remember: true,
    prompt: (name) => `${name} asked if we can work on a non-exclusive basis.`,
    options: () => [{ label: "Yes, non-exclusive is fine", line: "Happy to work on a non-exclusive basis." }],
  },
  buyers: {
    sides: ["seller"], remember: true,
    prompt: (name, region) => `${name} asked if we have buyers in ${region}.`,
    options: (region) => (region === REGIONS.europe || region === REGIONS.uk
      ? [{ label: "Yes, UK and Europe", line: "On buyers: yes, most of our second-life buyers are in the UK and Europe." }]
      : [
        { label: `We have buyers in ${region}`, line: `On buyers: yes, we work with second-life buyers in ${region}.` },
        { label: "UK and Europe, still interested", line: "On buyers: most of ours are in the UK and Europe, but a lot this size can still work, depending on price and shipping." },
      ]),
  },
  how_we_work: {
    sides: ["seller"], remember: true,
    prompt: (name) => `${name} asked how we work and what we charge.`,
    options: () => [
      { label: "Marketplace and direct, 10% commission", line: "How it works: we list the lot on our marketplace, which brings in the most interest, and take it directly to buyers in our network in parallel. There are no upfront fees, and our commission is 10% of the sale price, paid from the seller's proceeds." },
      { label: "Buy outright, or sell for the owner", line: "On how we work: either we buy the lot outright, or we sell it for the owner through our marketplace, where the buyer pays into a holding account and we take 10% on completion." },
    ],
  },
  pricing_buyer: {
    sides: ["buyer"], remember: true,
    prompt: (name) => `${name} asked for a price.`,
    options: () => [{ label: "We quote once we know the spec", line: "On price: we quote per lot, once we know exactly what you need." }],
  },
  collection: {
    sides: ["seller", "buyer"], remember: true,
    prompt: (name) => `${name} asked about collection or shipping.`,
    options: () => [],
  },
};
/** Topics the reader may return. "pricing" becomes the fixed rule for a seller and a question for a buyer;
 * "documents" needs no line of its own, the ask list answers it. */
export const ASKED_TOPICS = ["non_exclusive", "buyers", "how_we_work", "pricing", "documents", "collection"];

const SELLER_PRICE_RULE = (role: LeadRole) => `On price, we'd rather start from ${role === "broker" ? "the owner's" : "your"} figure than guess one.`;

/** The id a question and its saved answer go by: the topic, with the region for "buyers". */
export const questionId = (a: LeadAsked) => (a.topic === "buyers" ? `buyers:${a.region ?? ""}` : a.topic === "pricing" ? "pricing_buyer" : a.topic);

const squash = (text: string) => text.toLowerCase().replace(/[‘’‛′]/g, "'").replace(/[“”]/g, "\"").replace(/[‐-―]/g, "-")
  .replace(/[ ​-‍﻿]/g, " ").replace(/\s+/g, " ").trim();
/** Numbers as written, without thousands separators: "1,000" and "1 000" read as 1000. */
const numbersIn = (text: string) => (text.replace(/(\d)[,  ](?=\d{3}\b)/g, "$1").match(/\d+(?:[.,]\d+)?/g) ?? []).map((n) => n.replace(",", "."));

/** The quote is in the text, give or take spacing, case and typographic quotes. Short quotes prove nothing. */
export function quoteIn(quote: unknown, text: string): boolean {
  const q = typeof quote === "string" ? squash(quote).replace(/^["'. ]+|["'. …]+$/g, "") : "";
  return q.length >= 3 && squash(text).includes(q);
}

/** Every number in `value` is written somewhere in the text. */
export function numbersKnown(value: string, text: string): boolean {
  const known = new Set(numbersIn(text));
  return numbersIn(value).every((n) => known.has(n));
}

const NOT_A_NAME = new Set(["info", "sales", "admin", "office", "team", "enquiries", "enquiry", "contact", "hello", "hi", "support", "mail", "accounts", "purchasing", "procurement",
  "customer", "service", "department", "dept", "operations", "logistics", "marketing", "management", "reception", "billing", "orders", "noreply", "notifications",
  "the", "mr", "mrs", "ms", "dr", "sir", "dear", "kind", "best", "many", "thanks", "thank", "regards", "sent", "please", "looking", "yours", "with"]);
const nameLike = (word: string) => /^\p{L}[\p{L}'-]{1,24}$/u.test(word) && !NOT_A_NAME.has(word.toLowerCase());
const titled = (word: string) => (word === word.toLowerCase() || word === word.toUpperCase() ? word[0].toUpperCase() + word.slice(1).toLowerCase() : word);

const COMPANY_WORD = /^(ltd|limited|gmbh|llc|inc|bv|srl|sas|sarl|ab|oy|as|plc|group|energy|batter(y|ies)|solutions|recycling|motors?|autos?|garage|trading|company|co|corp|tech|technologies|systems|power|services|international|global|uk|europe|green|eco|planet|metals?|scrap|salvage|marine|industries|holdings|enterprises|ventures|partners|associates|supplies|trade|direct|online|electric(al)?|electronics|storage|renewables?|solar|assets?|recovery)\.?$/i;

/** A sign-off on a line of its own ("Kind regards,"), looking ahead to the line under it. */
const SIGN_OFF = /(?:^|\n)[ \t>]*(?:(?:kind|best|warm|many|with|yours)[ \t]+)*(?:regards|thanks|thank you|cheers|sincerely|best wishes|best)(?=[,!. \t]*\n+[ \t]*([^\n]{2,60}))/gi;
/** The name they signed with: the line under their sign-off, when it is one to three capitalised name words and nothing
 * else. "Thanks,\nPlease let me know" and "Many thanks\nlooking forward" are not names. */
function signedName(text: string): string | null {
  for (const m of text.matchAll(SIGN_OFF)) {
    const words = m[1].trim().replace(/[,.]$/, "").split(/\s+/);
    if (words.length <= 3 && words.every((w) => /^\p{Lu}/u.test(w) && nameLike(w) && !COMPANY_WORD.test(w))) return words[0];
  }
  return null;
}

/** The first name to greet: the From name when their address (first.last@) or sign-off backs it, or when it reads as a
 * person and they signed with nothing else; else the name they signed with. Never from the model. Null when unsure: the
 * reply then opens "Hello,". */
export function leadFirstName(fromName: string | null | undefined, fromEmail: string | null | undefined, text: string): string | null {
  const shown = (fromName ?? "").replace(/["<>()]/g, " ").trim();
  const words = (shown.includes(",") ? shown.split(",").reverse().join(" ") : shown).trim().split(/\s+/).filter(Boolean);
  const first = words[0] ?? "";
  const signed = signedName(text);
  if (first && !shown.includes("@") && nameLike(first)) {
    const lower = first.toLowerCase();
    const [local = "", domain = ""] = (fromEmail ?? "").toLowerCase().split("@");
    // "Green Scape" <info@greenscape.co.uk> is a company: its first word is in its own domain.
    const person = words.length >= 2 && words.length <= 3 && words.every((w) => nameLike(w) && !COMPANY_WORD.test(w)) && !domain.includes(lower);
    const parts = local.split(/[._-]/);
    const backed = (parts.length >= 2 && parts.includes(lower)) || signed?.toLowerCase() === lower;
    if (backed || (person && !signed)) return titled(first);
  }
  return signed ? titled(signed) : null;
}

export type LeadReading = { kind: "seller_lead" | "buyer_lead" | "other"; lot: "bulk" | "small" | "unclear"; why: string; unit: LeadUnit; role: LeadRole;
  summary: string | null; facts: LeadFact[]; asked: LeadAsked[]; other: LeadOther[] };

const str = (v: unknown, max = 200) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object") : []);

/** Turns the reader's answer into a reading, dropping whatever the email does not back: a fact or question whose quote
 * is not in the email (or its attachments), a fact whose numbers are not in it, a summary with a number of its own. */
export function verifyLead(raw: Record<string, unknown>, email: string, attached = ""): LeadReading {
  const all = `${email}\n${attached}`;
  const kind = raw.kind === "seller_lead" || raw.kind === "buyer_lead" ? raw.kind : "other";
  const unit: LeadUnit = raw.unit === "cells" || raw.unit === "packs" ? raw.unit : "modules";
  const role: LeadRole = raw.role === "owner" || raw.role === "broker" ? (quoteIn(raw.role_quote, email) ? raw.role : "unknown") : "unknown";
  const seen = new Set<string>();
  const facts = list(raw.facts).flatMap((f) => {
    const key = str(f.key, 30), value = str(f.value, 48);
    if (!FACT_KEYS[key] || !value || seen.has(key) || !quoteIn(f.quote, all) || !numbersKnown(value, all)) return [];
    seen.add(key);
    return [{ key, value }];
  });
  const topics = new Set<string>();
  const asked = list(raw.asked).flatMap((a) => {
    const topic = str(a.topic, 30), region = str(a.region, 30);
    if (!ASKED_TOPICS.includes(topic) || !quoteIn(a.quote, email)) return [];
    if (topic === "buyers" && !REGIONS[region]) return [];
    const entry = { topic, region: topic === "buyers" ? region : null, quote: str(a.quote, 300) };
    if (topics.has(questionId(entry))) return [];
    topics.add(questionId(entry));
    return [entry];
  });
  // A question on a topic this side has no fixed part for (a buyer asking how we work) is still theirs to have answered.
  const side: LeadSide = kind === "buyer_lead" ? "buyer" : "seller";
  const fits = (topic: string) => topic === "pricing" || topic === "documents" || !!TOPICS[topic]?.sides.includes(side);
  const quotes = new Set<string>();
  const other = [...asked.filter((a) => !fits(a.topic)), ...list(raw.other_questions).filter((q) => quoteIn(q.quote, email) && str(q.quote, 300).length >= 8).slice(0, 4)]
    .map((q) => str(q.quote, 300)).filter((quote) => !quotes.has(quote) && !!quotes.add(quote)).map((quote, i) => ({ id: `other:${i + 1}`, quote }));
  const summary = str(raw.summary, 160);
  return { kind, lot: raw.lot === "bulk" || raw.lot === "small" ? raw.lot : "unclear", why: str(raw.why, 120), unit, role,
    summary: summary && numbersKnown(summary, all) ? summary : null, facts, asked: asked.filter((a) => fits(a.topic)), other };
}

/** The facts for the "We have" row, most telling first. */
export function leadChips(facts: LeadFact[]): string[] {
  const rank = (key: string) => { const i = CHIP_ORDER.indexOf(key); return i < 0 ? CHIP_ORDER.length : i; };
  return [...facts].sort((a, b) => rank(a.key) - rank(b.key)).map((f) => f.value);
}

/** One of Alex's answers as it goes into the reply: a single run of text, no line breaks or control characters. */
export const cleanAnswer = (text: string) => text.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 1200);

/** Alex's choices as the card can hold them: only this card's asks and questions, answers cleaned. The page and the
 * server both pass choices through this, so the reply he sees is the reply that is saved. */
export function cleanLeadState(input: unknown, data: LeadData): LeadState {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const asks = new Set(asksFor(data.side, data.unit, data.role).map((a) => a.key));
  const ids = new Set([...data.asked.map(questionId), ...data.other.map((o) => o.id)]);
  const keys = (v: unknown, allowed: Set<string>) => [...new Set(Array.isArray(v) ? v.filter((k): k is string => typeof k === "string" && allowed.has(k)) : [])];
  const picks: Record<string, LeadPick> = {};
  for (const [id, pick] of Object.entries(raw.picks && typeof raw.picks === "object" ? raw.picks as Record<string, unknown> : {})) {
    if (!ids.has(id) || !pick || typeof pick !== "object") continue;
    const p = pick as { text?: unknown; remember?: unknown };
    picks[id] = { text: (typeof p.text === "string" && cleanAnswer(p.text)) || null, remember: p.remember === true };
  }
  return { off: keys(raw.off, asks), picks, reopened: keys(raw.reopened, ids) };
}

const join = (labels: string[]) => labels.join(", ");

/**
 * The reply as it stands: fixed parts, Alex's answers, and a blue question for each thing they asked that he has not
 * answered yet. `answers` are his saved answers by question id.
 */
export function assembleLead(data: LeadData, state: LeadState, answers: Record<string, string>): LeadReply {
  const name = data.firstName ?? "They";
  const picks = state.picks ?? {}, reopened = new Set(state.reopened ?? []), off = new Set(state.off ?? []);
  const open: string[] = [];
  const blocks: LeadBlock[] = [];

  /** A question's place in the reply: Alex's answer as a span, a blue question, or nothing (left out). */
  const resolve = (id: string, prompt: string, quote: string, options: LeadOption[], remember: boolean): LeadSpan | LeadBlock | null => {
    const pick = picks[id];
    if (pick) return pick.text?.trim() ? { text: pick.text.trim(), answer: { id, saved: false } } : null;
    const saved = answers[id]?.trim();
    if (saved && !reopened.has(id)) return { text: saved, answer: { id, saved: true } };
    open.push(id);
    const kept = saved && !options.some((o) => o.line === saved) ? [{ label: "Keep my saved answer", line: saved }] : [];
    return { kind: "question", id, prompt, quote, options: [...kept, ...options], remember };
  };
  /** Every question they asked on this topic (one, or one per region for "buyers"). */
  const topic = (key: string) => {
    const def = TOPICS[key];
    if (!def || !def.sides.includes(data.side)) return [];
    return data.asked.filter((a) => (a.topic === "pricing" ? "pricing_buyer" : a.topic) === key).map((a) => {
      const region = REGIONS[a.region ?? ""] ?? "";
      return resolve(questionId(a), def.prompt(name, region), a.quote, def.options(region), def.remember);
    });
  };
  const isBlock = (x: LeadSpan | LeadBlock | null): x is LeadBlock => !!x && "kind" in x;
  /** Adds a paragraph of the given spans, with any blue question among them placed after it. */
  const para = (...parts: (LeadSpan | LeadBlock | null)[]) => {
    const spans = parts.filter((p): p is LeadSpan => !!p && !isBlock(p));
    if (spans.length) blocks.push({ kind: "para", spans });
    blocks.push(...parts.filter(isBlock));
  };

  para({ text: data.firstName ? `Hi ${data.firstName},` : "Hello," });
  const thanks = data.facts.length >= 3 ? `Thanks for the details${data.sent === "photos" ? " and the photos" : data.sent === "files" ? " and the files" : ""}.` : "Thanks for getting in touch.";
  para({ text: thanks }, ...topic("non_exclusive"));
  para(...topic("buyers"));
  const pricing = data.side === "seller" && data.asked.some((a) => a.topic === "pricing") ? { text: SELLER_PRICE_RULE(data.role) } : null;
  para(...topic("how_we_work"), pricing, ...topic("pricing_buyer"));
  para(...topic("collection"));
  for (const q of data.other) para(resolve(q.id, `${name} asked:`, q.quote, [], false));

  const have = new Set(data.have);
  const missing = asksFor(data.side, data.unit, data.role).filter((a) => !have.has(a.key));
  const asks = missing.map((a) => ({ key: a.key, label: a.label, on: !off.has(a.key), card: !!a.card }));
  const on = missing.filter((a) => !off.has(a.key));
  const bullets = on.flatMap((a) => (a.bullet ? [a.bullet] : []));
  const doc = on.find((a) => a.doc)?.doc;
  const goal = data.side === "seller" ? "To put it in front of buyers" : "To find the right stock";
  if (doc || bullets.length) {
    blocks.push({ kind: "asks", bullets, intro: doc ? `${goal}, please send ${doc}${bullets.length ? ", and let me know:" : "."}` : `${goal}, please let me know:` });
  }
  para({ text: "Best,\nAlex" });

  const dropped = asks.filter((a) => !a.on), droppedCard = dropped.filter((a) => a.card);
  const cover: LeadReply["cover"] = !missing.length ? { text: "✓ They sent everything the deal card needs", tone: "ok" }
    : droppedCard.length ? { text: `! Not asking ${join(droppedCard.map((a) => a.label.toLowerCase()))}: the deal can't go to ${data.side === "seller" ? "buyers" : "sellers"} without it`, tone: "warn" }
    : dropped.length ? { text: `✓ Deal card covered · not asking ${join(dropped.map((a) => a.label))}`, tone: "ok" }
    : { text: "✓ Nothing missing for the deal card is left unasked", tone: "ok" };

  const body = blocks.flatMap((b) => (b.kind === "para" ? [b.spans.map((s) => s.text).join(" ")]
    : b.kind === "asks" ? [[b.intro, ...b.bullets.map((x) => `- ${x}`)].join("\n")] : [])).join("\n\n");
  return { blocks, body, open, asks, cover };
}

/**
 * The last check before a lead reply is saved for sending. The fixed parts hold no figure at all, so any digit or
 * currency sign outside Alex's own answers means something got in that should not have; and the greeting must use a
 * name their email carries. Returns what is wrong, in plain words; empty when the reply is safe. `allowOpen`: the reply
 * is going to the editor, not out, so an unanswered question may stay out of it.
 */
export function checkLeadReply(reply: LeadReply, data: LeadData, sender: { name: string | null; email: string }, allowOpen = false): string[] {
  const problems: string[] = [];
  const fixed = reply.blocks.flatMap((b) => (b.kind === "para" ? b.spans.filter((s) => !s.answer).map((s) => s.text) : b.kind === "asks" ? [b.intro, ...b.bullets] : []))
    .join("\n").replace(/UN38\.3/g, "");
  if (/[\d€£$]/.test(fixed)) problems.push("The reply holds a figure Relay did not get from you.");
  if (data.firstName && !squash(`${sender.name ?? ""}\n${data.email.text}`).includes(squash(data.firstName))) problems.push(`The name "${data.firstName}" is not in their email.`);
  if (reply.open.length && !allowOpen) problems.push("A blue question is still unanswered.");
  if (!sender.email.includes("@")) problems.push("There is no address to reply to.");
  if (reply.body.length < 40) problems.push("The reply is empty.");
  return problems;
}

/** A seller reply never offers a price. Alex's own answer may still hold one; the card says so before he sends. */
export function priceWarning(reply: LeadReply, data: LeadData): string | null {
  if (data.side !== "seller") return null;
  const own = reply.blocks.flatMap((b) => (b.kind === "para" ? b.spans.filter((s) => s.answer).map((s) => s.text) : [])).join("\n");
  return /[€£$]\s?\d|\d[\d.,]*\s?(?:eur|gbp|usd|euros?|pounds?|dollars?)\b/i.test(own) ? "Your answer names a price. Lead replies to sellers normally leave the first figure to them." : null;
}
