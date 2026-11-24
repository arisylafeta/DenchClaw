import { describe, expect, it } from "vitest";
import {
  buildBrief, cappedSql, checkReadOnlySql, claudeSessionCommand, deskPrompt, matchesQuery, MODE_TIMEOUT, readDeskArgs, rowsAnswer, stateText, staleAfterSeconds,
  type DeskState,
} from "./relay-desk-core";

const STATE: DeskState = {
  item: {
    id: "item-1", who: { name: "Ben Bament", email: "ben@silentclassics.co.uk", company: "Silent Classics" }, contact_type: "buyer", situation: "buyer_price",
    headline: "Wants price for 55/62kWh MEB battery", tab: "action", waiting_since: null, sending_as: "Alex's own address", reply_to: "ben@silentclassics.co.uk", deal: null,
  },
  thread: [{ message_id: "m1", direction: "inbound", from: "ben@silentclassics.co.uk", to: ["alex@rebattery.io"], cc: [], at: "2026-11-20 09:00", subject: "MEB pack", text: "Have you got a 62kWh MEB pack? Delivered to Bath.", has_files: true }],
  drafts: [{
    id: "d1", role: "primary", title: "Reply to Ben Bament", to: ["ben@silentclassics.co.uk"], cc: [], bcc: [], subject: "Re: MEB pack",
    body: "Hi Ben,\n\nWe have a VW ID.3 62 kWh at [BLANK: price for VW ID.3 62 kWh, 2020 (ref stock:41)] collected.\n\nBest,\nAlex", version: "2026-11-20T10:00:00.000Z",
    to_kind: "buyer", send_mode: "with_reply", send_at: null, included: true, waiting_to_send: false, sent: false,
    fills: [{ key: "stock:41", label: "VW ID.3 62 kWh, 2020", value: 5040, by: "relay", basis: "collected", working: ["Cost £4,500", "Margin 12%"], warnings: [] }],
  }],
  stock: [{ key: "stock:41", label: "VW ID.3 62 kWh, 2020", kind: "supplier", kwh: 62, year: 2020, soh: null, cost: { amount: 4500, currency: "GBP" }, listed: null, supplier: { name: "Parts Roberto", country: "IT" }, relay_price: { value: 5040, basis: "collected", working: [], warnings: [] } }],
  rules: ["Two to four short lines."],
};

describe("the read-only SQL guard", () => {
  it("takes one SELECT or WITH statement and drops a trailing semicolon", () => {
    expect(checkReadOnlySql("select id from crm_people limit 3;")).toEqual({ ok: true, sql: "select id from crm_people limit 3" });
    expect(checkReadOnlySql("  WITH x as (select 1) select * from x").ok).toBe(true);
  });
  it("refuses writes, DDL and more than one statement", () => {
    for (const sql of ["update crm_people set notes = ''", "delete from relay_item", "drop table x", "select 1; delete from relay_item", "insert into x values (1)",
      "with d as (delete from relay_item returning *) select * from d", "select * into scratch from crm_people", "explain analyze select 1", "set role postgres"]) {
      expect(checkReadOnlySql(sql).ok, sql).toBe(false);
    }
  });
  it("refuses secret tables and functions that reach outside the database", () => {
    expect(checkReadOnlySql("select password_hash from crm_users")).toEqual({ ok: false, why: "The table crm_users is private." });
    expect(checkReadOnlySql("select token_hash from CRM_SESSIONS").ok).toBe(false);
    expect(checkReadOnlySql("select pg_read_file('/etc/passwd')").ok).toBe(false);
    expect(checkReadOnlySql("select set_config('default_transaction_read_only','off',false)").ok).toBe(false);
    expect(checkReadOnlySql("select pg_sleep(60)").ok).toBe(false);
  });
  it("judges SQL, not words inside strings or comments", () => {
    expect(checkReadOnlySql("select * from mail_message where subject ilike '%update; delete%'").ok).toBe(true);
    expect(checkReadOnlySql("select 1 -- drop table x\n").ok).toBe(true);
    expect(checkReadOnlySql("select 1 /* ; */").ok).toBe(true);
    expect(checkReadOnlySql("select 'it''s ; fine'").ok).toBe(true);
    expect(checkReadOnlySql("select 1 /* unclosed").ok).toBe(false);
  });
  it("refuses empty and over-long input", () => {
    expect(checkReadOnlySql("").ok).toBe(false);
    expect(checkReadOnlySql(42).ok).toBe(false);
    expect(checkReadOnlySql(`select ${"1,".repeat(5000)}1`).ok).toBe(false);
  });
  it("caps rows one over the limit and says when it cut", () => {
    expect(cappedSql("select 1", 200)).toBe("select * from (\nselect 1\n) desk_query limit 201");
    const rows = Array.from({ length: 201 }, (_, i) => ({ i }));
    expect(rowsAnswer(rows).split("\n")[0]).toBe("200 rows (cut at 200; narrow the query)");
    expect(JSON.parse(rowsAnswer(rows).split("\n")[1])).toHaveLength(200);
    expect(rowsAnswer([{ a: 1 }]).startsWith("1 row\n")).toBe(true);
    expect(rowsAnswer([{ a: "x".repeat(100) }], 200, 50)).toContain("text cut at 50 characters");
  });
});

describe("the brief", () => {
  const brief = buildBrief({ mode: "quick", state: STATE, rules: STATE.rules, voice: { guide: "Short and warm.", card: "Buyers asking a price: give it, collected.", examples: [] }, now: new Date("2026-11-22T09:00:00Z") });
  it("sets the role and the hard limits", () => {
    expect(brief).toContain("You are Alex's email desk in Relay, working on one email.");
    expect(brief).toContain("change them only with the relay_* tools");
    expect(brief).toContain("Never create Gmail drafts and never send.");
    expect(brief).toContain("relay_ask");
    expect(brief).toContain("relay_remember_lesson");
    expect(brief).toContain("Today is 2026-11-22.");
  });
  it("carries the guards, the rules with reply-all, and the voice", () => {
    expect(brief).toContain("[BLANK: price for <label> (ref <key>)]");
    expect(brief).toContain("never carries a supplier's name");
    expect(brief).toContain("- Two to four short lines.");
    expect(brief).toMatch(/- Reply all:/);
    expect(brief).toContain("Short and warm.");
    expect(brief).toContain("Buyers asking a price");
    expect(brief).not.toMatch(/—/);
  });
  it("shows the email, the drafts with versions and prices, and internal stock as internal", () => {
    expect(brief).toContain("From: Ben Bament <ben@silentclassics.co.uk> at Silent Classics (buyer)");
    expect(brief).toContain("[d1] THE REPLY · draft · to ben@silentclassics.co.uk (the buyer) · version 2026-11-20T10:00:00.000Z");
    expect(brief).toContain("VW ID.3 62 kWh, 2020 (ref stock:41): £5,040, Relay's");
    expect(brief).toContain("has attachments (attachment_text) · message m1");
    expect(brief).toContain("Stock that fits (internal");
    expect(brief).toContain("Parts Roberto (IT); cost £4,500");
  });
  it("has instructions for each mode", () => {
    expect(brief).toContain("## Quick draft");
    expect(brief).toContain("at most two quick look-ups");
    const ahead = buildBrief({ mode: "ahead", state: STATE, rules: [], voice: null, now: new Date() });
    expect(ahead).toContain("## Background draft");
    expect(ahead).toContain("sign off \"Best,\"");
    expect(buildBrief({ mode: "chat", state: STATE, rules: [], voice: null, now: new Date() })).toContain("Do exactly what he asks");
  });
  it("says when there are no drafts, no stock and a chase", () => {
    const text = stateText({ ...STATE, item: { ...STATE.item, tab: "follow" }, drafts: [], stock: [], thread: [] });
    expect(text).toContain("No drafts yet.");
    expect(text).toContain("Stock that fits: none found.");
    expect(text).toContain("a reply here is a chase");
    expect(text).toContain("No messages on the thread.");
  });
  it("marks a draft waiting to send as not changeable", () => {
    expect(stateText({ ...STATE, drafts: [{ ...STATE.drafts[0], waiting_to_send: true }] })).toContain("waiting to send (no changes)");
    const withOthers = stateText({ ...STATE, others: [{ item_id: "i2", subject: "Battery in Belgium", at: "2026-11-12T20:43:00Z", text: "Kind regards, Muhammad Qasim" }] });
    expect(withOthers).toContain("Their other emails still waiting, on other threads (answer them in this one reply too");
    expect(withOthers).toContain("Muhammad Qasim");
    expect(stateText(STATE)).not.toContain("Their other emails");
  });
  it("shows the threads a reply depends on, the reply waiting there, and the cost, as internal", () => {
    const ricki = { item_id: "i9", status: "review" as const, name: "Ricki Mayhew", email: "ricki.mayhew@lkqsynetiq.co.uk", subject: "Re: VW ID.3 - tag 13319144", at: "2026-11-24T10:25:24.000Z",
      theirs: { at: "2026-11-24T10:25:24.000Z", message_id: "m9", text: "We have the mileage as 14,782. What is your offer?", has_files: false },
      draft: { draft_id: "d9", version: "2026-11-24T13:14:50.301Z", body: "Hi Rick, what would you let it go for?", by_alex: false, waiting_to_send: false, linked_item_id: null } };
    const shown = stateText({ ...STATE, related: [ricki], costs: [{ label: "Volkswagen ID.3 2025", supplier: "LKQ Synetiq", amount: 1674, currency: "GBP", source: "price sheet 19 Oct", listed: 1880 }] });
    expect(shown).toContain("--- Thread i9 with Ricki Mayhew <ricki.mayhew@lkqsynetiq.co.uk> (waiting on Alex)");
    expect(shown).toContain("We have the mileage as 14,782");
    expect(shown).toContain("(draft d9, version 2026-11-24T13:14:50.301Z):\nHi Rick");
    expect(shown).toContain("never in an email to the buyer): Volkswagen ID.3 2025 from LKQ Synetiq: £1,674 (price sheet 19 Oct)");
    expect(stateText({ ...STATE, related: [{ ...ricki, draft: null, theirs: null }] })).toContain("No reply waiting there.");
    expect(stateText(STATE)).not.toContain("Cost on record");
    expect(stateText({ ...STATE, drafts: [{ ...STATE.drafts[0], warnings: ["£1,570 is £104 under the cost."] }] })).toContain("For Alex, never in an email: £1,570");
  });
  it("tells every first draft to ask whoever has the answer", () => {
    for (const mode of ["quick", "ahead", "chat"] as const) {
      const b = buildBrief({ mode, state: STATE, rules: [], voice: null, now: new Date() });
      expect(b).toContain("Ask whoever has the answer");
      expect(b).toContain("reply_on");
    }
  });
});

describe("the turn's prompt and the modes", () => {
  it("passes Alex's chat message through and asks for a first reply otherwise", () => {
    expect(deskPrompt("chat", "  make it shorter ")).toBe("make it shorter");
    expect(deskPrompt("quick", "")).toBe("Write the first reply to this email.");
    expect(deskPrompt("ahead", "offer the ID.3")).toBe("Write the first reply to this email.\n\nAlex's note: offer the ID.3");
  });
  it("gives each mode its time and a margin before a run is called stale", () => {
    expect(MODE_TIMEOUT).toEqual({ quick: 180, ahead: 360, chat: 660 });
    expect(staleAfterSeconds("chat")).toBe(780);
  });
  it("builds the Continue in Claude command", () => {
    expect(claudeSessionCommand("abc")).toBe("cd /root/.hermes && CLAUDE_CONFIG_DIR=/root/.claude-alex claude --resume abc");
  });
});

describe("the tools' arguments", () => {
  it("reads a reply, with defaults", () => {
    expect(readDeskArgs("relay_write_reply", { body: " Hi Ben " })).toEqual({ ok: true, args: { body: "Hi Ben", subject: undefined, reason: "Relay's reply" } });
    expect(readDeskArgs("relay_write_reply", { body: "" })).toEqual({ ok: false, why: "body can't be empty." });
    expect(readDeskArgs("relay_write_reply", { body: "x".repeat(8001) }).ok).toBe(false);
  });
  it("needs a version and something to change for an update, and real addresses", () => {
    expect(readDeskArgs("relay_update_draft", { draft_id: "d1", version: "v" })).toEqual({ ok: false, why: "Nothing to change: give body, subject, to, cc or bcc." });
    expect(readDeskArgs("relay_update_draft", { draft_id: "d1", body: "x" })).toEqual({ ok: false, why: "version is required." });
    expect(readDeskArgs("relay_update_draft", { draft_id: "d1", version: "v", cc: ["not-an-address"] })).toEqual({ ok: false, why: "\"not-an-address\" in cc isn't an email address." });
    const ok = readDeskArgs("relay_update_draft", { draft_id: "d1", version: "v", cc: "a@b.co, c@d.com" });
    expect(ok.ok && ok.args.cc).toEqual(["a@b.co", "c@d.com"]);
    expect(readDeskArgs("relay_update_draft", { draft_id: "d1", version: "v", to: [] })).toEqual({ ok: false, why: "to can't be empty." });
  });
  it("checks a linked email's side, send mode and time", () => {
    const base = { to: "roberto@parts.it", to_kind: "supplier", subject: "VIN", body: "Hi Roberto" };
    expect(readDeskArgs("relay_add_email", base)).toMatchObject({ ok: true, args: { send_mode: "with_reply", send_at: null, on_thread: false } });
    expect(readDeskArgs("relay_add_email", { ...base, to_kind: "friend" }).ok).toBe(false);
    expect(readDeskArgs("relay_add_email", { ...base, send_mode: "at" })).toEqual({ ok: false, why: "send_mode at needs send_at as an ISO time." });
    expect(readDeskArgs("relay_add_email", { ...base, send_mode: "unless_reply", send_at: "2026-11-24T09:00:00Z" })).toMatchObject({ ok: true, args: { send_at: "2026-11-24T09:00:00.000Z" } });
    expect(readDeskArgs("relay_add_email", { ...base, to: "nobody" }).ok).toBe(false);
    expect(readDeskArgs("relay_add_email", { ...base, subject: undefined }).ok).toBe(false);
    expect(readDeskArgs("relay_add_email", { ...base, subject: undefined, reply_on: "i2", draft_version: "v1" })).toMatchObject({ ok: true, args: { reply_on: "i2", draft_version: "v1", subject: "" } });
    expect(readDeskArgs("relay_add_email", { ...base, draft_version: "v1" }).ok).toBe(false);
    expect(readDeskArgs("relay_add_email", { ...base, reply_on: "i2", on_thread: true }).ok).toBe(false);
    expect(readDeskArgs("relay_threads", { person: "Ricki Mayhew" })).toEqual({ ok: true, args: { person: "Ricki Mayhew", about: "" } });
    expect(readDeskArgs("relay_threads", {}).ok).toBe(false);
  });
  it("rounds prices to whole pounds and allows clearing one", () => {
    expect(readDeskArgs("relay_set_price", { draft_id: "d1", key: "stock:41", value: 5040.4 })).toMatchObject({ ok: true, args: { value: 5040 } });
    expect(readDeskArgs("relay_set_price", { draft_id: "d1", key: "stock:41", value: null })).toMatchObject({ ok: true, args: { value: null } });
    expect(readDeskArgs("relay_set_price", { draft_id: "d1", key: "stock:41", value: "5040" }).ok).toBe(false);
    expect(readDeskArgs("relay_set_price", { draft_id: "d1", key: "stock:41", value: -1 }).ok).toBe(false);
  });
  it("needs two to four answers for a question", () => {
    expect(readDeskArgs("relay_ask", { question: "Buy it?", options: ["Yes"] }).ok).toBe(false);
    expect(readDeskArgs("relay_ask", { question: "Buy it?", options: ["Yes", "No", "Ask for photos"] })).toMatchObject({ ok: true });
    expect(readDeskArgs("relay_ask", { question: "Buy it?", options: ["a", "b", "c", "d", "e"] }).ok).toBe(false);
  });
  it("clamps a listing search and checks an address", () => {
    expect(readDeskArgs("marketplace_listings", { query: "ID.3", limit: 500 })).toEqual({ ok: true, args: { query: "ID.3", limit: 25 } });
    expect(readDeskArgs("marketplace_listings", {})).toEqual({ ok: true, args: { query: "", limit: 10 } });
    expect(readDeskArgs("marketplace_account", { email: "Ben@SilentClassics.co.uk" })).toEqual({ ok: true, args: { email: "ben@silentclassics.co.uk" } });
    expect(readDeskArgs("marketplace_account", { email: "*@x.com" }).ok).toBe(false);
  });
  it("takes a non-object as no arguments", () => {
    expect(readDeskArgs("relay_state", "nonsense")).toEqual({ ok: true, args: {} });
    expect(readDeskArgs("crm_query", null)).toEqual({ ok: false, why: "sql is required." });
  });
});

describe("marketplace search words", () => {
  it("needs every word, in any order", () => {
    expect(matchesQuery("VW ID.3 62 kWh pack 2020", "id.3 62")).toBe(true);
    expect(matchesQuery("VW ID.3 62 kWh pack 2020", "tesla")).toBe(false);
    expect(matchesQuery("anything", "")).toBe(true);
  });
  it("writes a team inbox's reply as the team, not as Alex", () => {
    const team = buildBrief({ mode: "quick", state: { ...STATE, item: { ...STATE.item, team_inbox: "supply@rebattery.io" } }, rules: [], voice: null, now: new Date("2026-11-22T09:00:00Z") });
    expect(team).toContain("goes from supply@rebattery.io, a ReBattery team inbox");
    expect(team).toContain('"The ReBattery team"');
    expect(team).not.toContain('then \\"Alex\\" on its own line');
    const own = buildBrief({ mode: "quick", state: STATE, rules: [], voice: null, now: new Date("2026-11-22T09:00:00Z") });
    expect(own).not.toContain("team inbox");
    expect(own).toContain('"Alex" on its own line');
  });
});
