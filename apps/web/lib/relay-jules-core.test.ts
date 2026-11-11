import { describe, expect, it } from "vitest";
import { julesChatUrl, julesReply, julesWords, looksLikeJulesReply, parseJulesWatch, type JulesMail } from "./relay-jules-core";

// Made-up notes in the shape the job writes.
const CHAT = "11111111-2222-4333-8444-555555555555";
const NOTES = {
  cursor: ["2026-11-10T13:02:27.028728+00:00", "gmail_msg_c"],
  applied: ["gmail_msg_a"],
  pending: { gmail_msg_b: { message_id: "gmail_msg_b", conversation_id: CHAT, reply_text: "Where do I drop it off?" } },
  needs_human: { gmail_msg_c: { message_id: "gmail_msg_c", needs_human: true, candidate_conversations: [CHAT], reason: "attribution_not_verified" } },
  reported: [],
};
const mail = (over: Partial<JulesMail> = {}): JulesMail => ({
  id: "gmail_msg_z", subject: "Re: Your Acme AB-100 5kWh packs", in_reply_to: "<aaaa-bbbb@mtasv.net>", rfc_references: null,
  to: ["supply@rebattery.io"], has_attachments: false, unread: false, ours: false, ...over,
});

describe("parseJulesWatch", () => {
  it("reads the job's notes", () => {
    const watch = parseJulesWatch(NOTES)!;
    expect(watch.cursor).toEqual(["2026-11-10T13:02:27.028728+00:00", "gmail_msg_c"]);
    expect([...watch.applied]).toEqual(["gmail_msg_a"]);
    expect(watch.pending.get("gmail_msg_b")).toBe(CHAT);
    expect(watch.unmatched.get("gmail_msg_c")).toBe(CHAT);
  });

  it("names no chat when the job had more than one in mind, or the id is not one", () => {
    const watch = parseJulesWatch({ ...NOTES, pending: { x: { conversation_id: "../admin" } }, needs_human: { y: { candidate_conversations: [CHAT, CHAT.replace("1", "2")] } } })!;
    expect(watch.pending.get("x")).toBeNull();
    expect(watch.unmatched.get("y")).toBeNull();
  });

  it("works without the lists an older file lacks, and refuses what is not notes", () => {
    const watch = parseJulesWatch({ cursor: ["not a date", ""], applied: [], pending: {} })!;
    expect(watch.cursor).toBeNull();
    expect(watch.unmatched.size).toBe(0);
    for (const bad of [null, [], "x", { pending: {} }, { applied: [] }]) expect(parseJulesWatch(bad)).toBeNull();
  });
});

describe("julesReply", () => {
  const watch = parseJulesWatch(NOTES);
  const at = "2026-11-10T22:25:00.000Z";

  it("says what the job made of an email it knows", () => {
    expect(julesReply(mail({ id: "gmail_msg_a" }), watch, at)).toEqual({ state: "added", conversation_id: null, files: false, checked_at: at });
    expect(julesReply(mail({ id: "gmail_msg_b", has_attachments: true }), watch, at)).toEqual({ state: "read", conversation_id: CHAT, files: true, checked_at: at });
    expect(julesReply(mail({ id: "gmail_msg_c" }), watch, at)?.state).toBe("unmatched");
  });

  it("knows them whatever the email looks like", () => {
    expect(julesReply(mail({ id: "gmail_msg_b", subject: "Photos", in_reply_to: null, to: [] }), watch, at)?.state).toBe("read");
  });

  it("flags an answer to Jules that came in after the job's last read", () => {
    expect(julesReply(mail({ unread: true }), watch, at)?.state).toBe("unread");
  });

  it("flags an answer to Jules the job went past without a note", () => {
    expect(julesReply(mail({ has_attachments: true }), watch, at)).toEqual({ state: "skipped", conversation_id: null, files: true, checked_at: at });
  });

  it("flags nothing that answers an email the CRM sent, old or new", () => {
    expect(julesReply(mail({ id: "gmail_msg_c", ours: true }), watch, at)).toBeNull();
    expect(julesReply(mail({ ours: true }), watch, at)).toBeNull();
    expect(julesReply(mail({ ours: true, unread: true }), watch, at)).toBeNull();
  });

  it("flags nothing that is not an answer to Jules", () => {
    expect(julesReply(mail({ subject: "Re: Collection on Friday" }), watch, at)).toBeNull();
    expect(julesReply(mail({ unread: true, subject: "Re: New message about Acme AB-100", to: ["support@rebattery.io"] }), watch, at)).toBeNull();
    expect(julesReply(mail({ unread: true, in_reply_to: "<abc@mail.gmail.com>" }), watch, at)).toBeNull();
    expect(julesReply(mail({ unread: true, to: ["alex@rebattery.io"] }), watch, at)).toBeNull();
  });

  it("flags nothing without the job's notes", () => {
    expect(julesReply(mail({ id: "gmail_msg_a", unread: true }), null, null)).toBeNull();
  });
});

describe("looksLikeJulesReply", () => {
  it("takes both of Jules's subjects, and the thread from the references", () => {
    expect(looksLikeJulesReply(mail({ subject: "RE: Re: Your Acme AB-100 listing is ready" }))).toBe(true);
    expect(looksLikeJulesReply(mail({ subject: "Re: Your Acme AB-100 cells", in_reply_to: null, rfc_references: "<x@mail.example> <y@mtasv.net>", to: ["Supply@ReBattery.io "] }))).toBe(true);
  });

  it("leaves an answer to Alex's own reply on a Jules thread alone", () => {
    expect(looksLikeJulesReply(mail({ in_reply_to: "<CAxyz@mail.gmail.com>", rfc_references: "<aaaa-bbbb@mtasv.net> <CAxyz@mail.gmail.com>" }))).toBe(false);
  });

  it("takes a draft with no name and the first thank-you", () => {
    expect(looksLikeJulesReply(mail({ subject: "Re: Your packs" }))).toBe(true);
    expect(looksLikeJulesReply(mail({ subject: "Re: We've received your Acme AB-100 details" }))).toBe(true);
  });

  it("leaves the marketplace's own emails alone", () => {
    expect(looksLikeJulesReply(mail({ subject: "Re: Your offer was accepted: Acme AB-100 5kWh packs" }))).toBe(false);
    expect(looksLikeJulesReply(mail({ subject: "Re: Your alert is paused: Acme packs" }))).toBe(false);
  });

  it("leaves a first email and other subjects alone", () => {
    expect(looksLikeJulesReply(mail({ subject: "Your Acme AB-100 packs" }))).toBe(false);
    expect(looksLikeJulesReply(mail({ subject: "Re: Your invoice" }))).toBe(false);
    expect(looksLikeJulesReply(mail({ subject: null }))).toBe(false);
  });
});

describe("julesChatUrl", () => {
  it("links a chat and nothing else", () => {
    expect(julesChatUrl(CHAT)).toBe(`https://www.rebattery.io/operations/jules/${CHAT}`);
    expect(julesChatUrl("x/../y")).toBeNull();
    expect(julesChatUrl(null)).toBeNull();
  });
});

describe("julesWords", () => {
  const reply = (state: "added" | "read" | "unmatched" | "unread" | "skipped", files = false) => ({ state, conversation_id: null, files, checked_at: null });

  it("has a chip and a line for each state", () => {
    expect(julesWords(reply("added")).chip).toBe("Added by Jules");
    expect(julesWords(reply("read")).chip).toBe("Read by Jules, not added");
    expect(julesWords(reply("unmatched")).tone).toBe("amber");
    expect(julesWords(reply("skipped")).chip).toBe("Not picked up by Jules");
    expect(julesWords(reply("unread"), "40 min").line).toContain("last 40 min ago");
    expect(julesWords(reply("unread")).line).not.toContain("last");
  });

  it("says files do not reach the listing, only when there are some", () => {
    expect(julesWords(reply("read", true)).line).toContain("photos have to be added to the listing by hand");
    expect(julesWords(reply("read")).line).not.toContain("photos");
  });
});
