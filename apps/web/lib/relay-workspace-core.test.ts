import { describe, expect, it } from "vitest";
import type { TalkDraft } from "./relay-talk";
import type { PriceFill } from "./relay-price-types";
import type { WaitingRow } from "./relay-rank-core";
import { addressList, dealLine, shortPlace, earlierRows, fromEditable, toEditable,
  bodyPieces, draftNeeds, gapSpans, listEntries, matchesRow, paragraphs, parsePrice, sendGate, tabNote, versionsOf, visibleRows, waitedDays, whenWords,
  type Bands,
} from "./relay-workspace-core";

const NOW = new Date("2026-11-20T10:00:00Z");
const P62 = "[BLANK: price for VW ID.3 62 kWh, 2020 (ref stock:sto_62)]";
const P58 = "[BLANK: price for VW ID.3 58 kWh (ref market:lst_58)]";
const BODY = `Hi Ben,\n\nGreat to hear from you, and sorry for the slow reply.\n\nVW ID.3 62 kWh, 2020: £${P62} collected.\nVW ID.3 58 kWh: £${P58} collected.\n\nWe can get the age and mileage on [BLANK: day we can send it].\n\nBest,\nAlex`;

const fill = (key: string, value: number | null, by: PriceFill["by"] = "relay"): PriceFill => ({
  key, label: key, value, basis: "collected", working: [], warnings: [], needsDeliveryQuote: false, by,
});

const draft = (over: Partial<TalkDraft> & { main?: string }): TalkDraft => {
  const { main = "Hi,\n\nThanks.\n\nBest,\nAlex", ...rest } = over;
  return {
    id: "d1", role: "primary", position: 0, title: "Reply to Ben", why: "", state: "draft", to_kind: "buyer", send_mode: "with_reply", send_at: null, included: true,
    mail: { id: "m1", state: "draft", from_email: "alex@rebattery.io", to_emails: ["ben@example.co.uk"], cc_emails: [], bcc_emails: [], subject: "Re: MEB pack", main, updated_at: "2026-11-20T09:00:00.000Z", scheduled: null, failure: null },
    change: null, undone: null, marks: [], leaks: [], fills: [], gaps: false, price_markers: false,
    ...rest,
  };
};

describe("gaps in a body", () => {
  it("finds each gap where it sits, with its stock key when it is a price", () => {
    const spans = gapSpans(BODY);
    expect(spans.map((g) => BODY.slice(g.start, g.end))).toEqual([P62, P58, "[BLANK: day we can send it]"]);
    expect(spans.map((g) => g.priceKey)).toEqual(["stock:sto_62", "market:lst_58", null]);
    expect(spans.map((g) => g.index)).toEqual([0, 1, 2]);
  });

  it("reads loose markers the way the server does", () => {
    const body = "Price: [ PRICE ] and [BLANK] then [BLANK - quantity].";
    expect(gapSpans(body).map((g) => body.slice(g.start, g.end))).toEqual(["[ PRICE ]", "[BLANK]", "[BLANK - quantity]"]);
  });
});

describe("body to pieces", () => {
  it("turns price markers into price fields and other gaps into gap fields", () => {
    const pieces = bodyPieces(BODY);
    expect(pieces.filter((p) => p.kind === "price")).toEqual([
      { kind: "price", index: 0, key: "stock:sto_62", label: "VW ID.3 62 kWh, 2020", marked: false },
      { kind: "price", index: 1, key: "market:lst_58", label: "VW ID.3 58 kWh", marked: false },
    ]);
    expect(pieces.filter((p) => p.kind === "gap")).toEqual([{ kind: "gap", index: 2, label: "day we can send it", marked: false }]);
    expect(pieces.map((p) => (p.kind === "text" ? p.text : `<${p.index}>`)).join("")).toBe(BODY.replace(P62, "<0>").replace(P58, "<1>").replace("[BLANK: day we can send it]", "<2>"));
  });

  it("marks only the changed words", () => {
    const start = BODY.indexOf("Great");
    const end = BODY.indexOf(", and");
    const pieces = bodyPieces(BODY, [{ start, end, removed: "Thanks" }]);
    expect(pieces.filter((p) => p.kind === "text" && p.marked).map((p) => (p as { text: string }).text)).toEqual(["Great to hear from you"]);
  });

  it("marks a price field a change touched, and ignores empty deletion marks", () => {
    const at = BODY.indexOf(P62);
    const pieces = bodyPieces(BODY, [{ start: at, end: at + P62.length, removed: "" }, { start: 3, end: 3, removed: "there" }]);
    expect(pieces.find((p) => p.kind === "price" && p.key === "stock:sto_62")?.marked).toBe(true);
    expect(pieces.some((p) => p.kind === "text" && p.marked)).toBe(false);
  });

  it("splits into paragraphs at blank lines and keeps single line breaks", () => {
    const paras = paragraphs(BODY);
    expect(paras).toHaveLength(5);
    expect(paras[0]).toEqual([{ kind: "text", text: "Hi Ben,", marked: false }]);
    expect(paras[2].map((p) => p.kind)).toEqual(["text", "price", "text", "price", "text"]);
    expect(paras[4]).toEqual([{ kind: "text", text: "Best,\nAlex", marked: false }]);
  });

  it("keeps a mark that crosses a paragraph break on both sides", () => {
    const body = "One.\n\nTwo.";
    const paras = paragraphs(body, [{ start: 0, end: body.length, removed: "" }]);
    expect(paras).toEqual([[{ kind: "text", text: "One.", marked: true }], [{ kind: "text", text: "Two.", marked: true }]]);
  });
});

describe("prices", () => {
  it("reads what Alex types", () => {
    expect(parsePrice("5,350")).toEqual({ value: 5350 });
    expect(parsePrice(" £4 999.6 ")).toEqual({ value: 5000 });
    expect(parsePrice("")).toEqual({ value: null });
    expect(parsePrice("5k")).toHaveProperty("error");
  });

  it("counts what a draft still needs", () => {
    expect(draftNeeds(BODY, [fill("stock:sto_62", 5350), fill("market:lst_58", null)])).toEqual({ emptyPrices: 1, otherGaps: 1, relayPrices: 1, alexPrices: 0 });
    expect(draftNeeds(BODY, [fill("stock:sto_62", 5350, "alex"), fill("market:lst_58", 3610)], { 2: "Monday" })).toEqual({ emptyPrices: 0, otherGaps: 0, relayPrices: 1, alexPrices: 1 });
  });

  it("says it under the tab", () => {
    const d = draft({ main: BODY });
    expect(tabNote(d, draftNeeds(BODY, []), NOW)).toEqual({ text: "3 prices to fill", tone: "warn" });
    expect(tabNote(d, { emptyPrices: 0, otherGaps: 0, relayPrices: 2, alexPrices: 0 }, NOW)).toEqual({ text: "2 prices by Relay", tone: "warn" });
    expect(tabNote({ ...d, role: "follow", included: false }, { emptyPrices: 0, otherGaps: 0, relayPrices: 0, alexPrices: 0 }, NOW).text).toBe("Not sending");
    expect(tabNote({ ...d, state: "sent" }, draftNeeds(BODY, []), NOW).text).toBe("Sent");
  });

  it("says when a linked email goes", () => {
    expect(whenWords({ send_mode: "with_reply", send_at: null }, NOW)).toBe("With the reply");
    expect(whenWords({ send_mode: "unless_reply", send_at: "2026-11-25T09:00:00Z" }, NOW)).toBe("Wed 9:00, unless they reply");
    expect(whenWords({ send_mode: "at", send_at: null }, NOW)).toBe("Pick a time");
  });
});

describe("the Send gate", () => {
  const priced = draft({ main: `Hi Ben,\n\nThe 62 kWh is £${P62} collected.`, fills: [fill("stock:sto_62", 5350)] });
  const chase = draft({ id: "d2", role: "follow", title: "Chase Ben", send_mode: "unless_reply", send_at: "2026-11-25T09:00:00Z", to_kind: "buyer" });
  const roberto = draft({ id: "d3", role: "follow", title: "Ask Parts Roberto for the VIN", to_kind: "supplier", mail: { ...draft({}).mail!, id: "m3", to_emails: ["vendite@partsroberto.it"] } });

  it("counts the ticked linked emails and warns about Relay's prices", () => {
    const gate = sendGate([priced, chase, roberto]);
    expect(gate.ready).toBe(true);
    expect(gate.label).toBe("Send the reply and 2 more");
    expect(gate.line).toBe("The yellow price is Relay’s. Change any, or send. 30 seconds to undo.");
    expect(gate.tone).toBe("warn");
    expect(versionsOf(gate.going)).toEqual({ d1: "2026-11-20T09:00:00.000Z", d2: "2026-11-20T09:00:00.000Z", d3: "2026-11-20T09:00:00.000Z" });
  });

  it("leaves out unticked and sent linked emails", () => {
    const gate = sendGate([{ ...priced, fills: [fill("stock:sto_62", 5350, "alex")] }, { ...chase, included: false }, { ...roberto, state: "sent" }]);
    expect(gate).toMatchObject({ ready: true, label: "Send the reply", line: "Ready. 30 seconds to undo.", tone: "ok" });
  });

  it("blocks on an empty price, and says where", () => {
    expect(sendGate([{ ...priced, fills: [fill("stock:sto_62", null)] }])).toMatchObject({ ready: false, line: "Fill the empty price to send.", tone: "block" });
    const gappy = { ...roberto, mail: { ...roberto.mail!, main: "Hi,\n\nCould you send it by [BLANK: day]?" } };
    expect(sendGate([{ ...priced }, gappy]).line).toBe("Fill the gap in “Ask Parts Roberto for the VIN” to send.");
  });

  it("lets a typed gap through before it is saved", () => {
    const gappy = draft({ main: "Hi,\n\nWe can send it on [BLANK: day].", gaps: true });
    expect(sendGate([gappy]).ready).toBe(false);
    expect(sendGate([gappy], { d1: { 0: "Monday" } }).ready).toBe(true);
  });

  it("blocks a leak with its reason", () => {
    const leaking = { ...roberto, leaks: [{ kind: "buyer_name" as const, found: "Ben Bament", text: "Names the buyer (Ben Bament)." }] };
    expect(sendGate([priced, leaking])).toMatchObject({ ready: false, tone: "danger", line: "“Ask Parts Roberto for the VIN” names the buyer (Ben Bament). Ask Relay to take it out." });
    expect(tabNote(leaking, { emptyPrices: 0, otherGaps: 0, relayPrices: 0, alexPrices: 0 }, NOW)).toEqual({ text: "Can't go like this", tone: "danger" });
  });

  it("blocks a timed email with no time, and a reply with no recipient", () => {
    expect(sendGate([priced, { ...chase, send_at: null }]).line).toBe("Pick when “Chase Ben” goes.");
    expect(sendGate([{ ...priced, mail: { ...priced.mail!, to_emails: [] } }]).line).toBe("The reply has no recipient.");
  });

  it("trusts the server when it sees a gap the page doesn't", () => {
    expect(sendGate([draft({ gaps: true })]).ready).toBe(false);
  });

  it("is read only once the reply has gone or waits to go", () => {
    expect(sendGate([{ ...priced, state: "sent" }])).toMatchObject({ ready: false, line: "The reply has gone." });
    expect(sendGate([{ ...priced, mail: { ...priced.mail!, scheduled: { at: "2026-11-21T08:00:00Z", undo: false, unless_reply: false } } }]).line).toBe("The reply is waiting to send.");
    expect(sendGate([]).line).toBe("No reply yet. Tell Relay how to answer.");
  });
});

describe("the list", () => {
  const row = (name: string, band: WaitingRow["band"], ask = "Price for a pack"): WaitingRow => ({
    score: 50, band, tag: null, why: [], key: name, name, company: null, ask, waited: "2 d", waitingSince: null, itemIds: [name], openId: name, reviewIds: [],
    emails: 1, hasDraft: false, contactType: null,
  });
  const bands: Bands = {
    now: [row("Ben Bament", "now")],
    today: Array.from({ length: 10 }, (_, k) => row(`Today ${k + 1}`, "today")),
    week: [row("Wedd", "week", "MG5 packs")],
    later: [],
  };

  it("shows Now, the first of Today with the rest behind More, and folds This week", () => {
    const entries = listEntries(bands, { todayLimit: 6 });
    expect(entries.map((e) => (e.kind === "row" ? e.row.name : `${e.kind}:${e.band}:${"n" in e ? e.n : ""}`))).toEqual([
      "head:now:1", "Ben Bament", "head:today:10", "Today 1", "Today 2", "Today 3", "Today 4", "Today 5", "Today 6", "more:today:4", "fold:week:1",
    ]);
    expect(visibleRows(listEntries(bands, { todayLimit: 6, open: { today: true, week: true } }))).toHaveLength(12);
  });

  it("searches every band, unfolded", () => {
    expect(visibleRows(listEntries(bands, { query: "mg5" })).map((r) => r.name)).toEqual(["Wedd"]);
    expect(matchesRow({ name: "Ben Bament", company: "Silent Classics", ask: "MEB pack" }, "silent ben")).toBe(true);
  });

  it("reads how long they waited", () => {
    expect(waitedDays("7 d")).toBe(7);
    expect(waitedDays("today")).toBe(0);
  });
});

describe("earlierRows", () => {
  const email = (at: string, direction: string) => ({ direction, at, from_email: direction === "outbound" ? "alex@rebattery.io" : "fabiano@eecc.swiss" });
  it("puts each summary over its email by day and side, once each", () => {
    const rows = earlierRows(
      [email("2026-11-03T09:00:00Z", "inbound"), email("2026-11-02T15:00:00Z", "outbound"), email("2026-11-02T08:00:00Z", "inbound"), email("2026-10-01T08:00:00Z", "inbound")],
      [{ who: "Fabiano", when: "03 Nov", summary: "Thanked Alex." }, { who: "Alex", when: "02 Nov", summary: "Promised to come back." }, { who: "Fabiano", when: "2 Nov", summary: "Re-sent the offer." }],
      "Fabiano",
    );
    expect(rows.map((r) => [r.when, r.who, r.summary])).toEqual([
      ["03 Nov", "Fabiano", "Thanked Alex."], ["02 Nov", "Alex", "Promised to come back."], ["02 Nov", "Fabiano", "Re-sent the offer."], ["01 Oct", "Fabiano", null],
    ]);
  });
});

describe("toEditable / fromEditable", () => {
  const body = "Hi Ben,\n\nVW ID.3 62 kWh: [BLANK: price for VW ID.3 62 kWh, 2020 (ref stock:a1)] collected.\nAnd [BLANK: who collects]?";
  it("shows price markers as short placeholders and puts them back on save", () => {
    const { text, markers } = toEditable(body);
    expect(text).toBe("Hi Ben,\n\nVW ID.3 62 kWh: [price: VW ID.3 62 kWh, 2020] collected.\nAnd [BLANK: who collects]?");
    expect(fromEditable(text.replace("Hi Ben,", "Hello Ben,"), markers)).toBe(body.replace("Hi Ben,", "Hello Ben,"));
  });
  it("keeps two lines with the same label apart", () => {
    const two = "[BLANK: price for ID.3 (ref stock:a)] or [BLANK: price for ID.3 (ref stock:b)]";
    const { text, markers } = toEditable(two);
    expect(text).toBe("[price: ID.3] or [price: ID.3 (2)]");
    expect(fromEditable(text, markers)).toBe(two);
  });
  it("reads addresses however they're typed", () => {
    expect(addressList("Ben@x.com, sean@rebattery.io;  <tom@y.co.uk>")).toEqual(["ben@x.com", "sean@rebattery.io", "tom@y.co.uk"]);
  });
});

describe("dealLine", () => {
  it("names Fabiano's lot and gives the facts he'd reply with", () => {
    expect(dealLine({ kind: "supply", summary: "120 new LG Energy Solution EM048128P6BA NMC battery modules", quantity: "120 modules", status: "open",
      title: "120x LG EM048128P6BA 6.6kWh NMC Modules", location: "Dallas, USA", price: "Seller ask: 3,000 per module x 120; currency stated as EUR/USD, taken as EUR" }, "x"))
      .toEqual({ type: "Bulk trade", name: "120x LG EM048128P6BA 6.6kWh NMC Modules", facts: ["selling", "792 kWh", "3,000 each", "Dallas, USA"], closed: false });
  });
  it("keeps the quantity when there's no title, and leaves out what it can't read", () => {
    expect(dealLine({ kind: "demand", summary: "Faysal's sourcing matrix", quantity: "92-102 packs across 5 lines", status: "open", title: null, location: null, price: null }, "x"))
      .toEqual({ type: "Bulk trade", name: "Faysal's sourcing matrix", facts: ["buying", "92-102 packs across 5 lines"], closed: false });
  });
  it("reads a price per kWh and a lot in MWh", () => {
    const line = dealLine({ kind: "supply", summary: "s", quantity: "400 modules", status: "closed", title: "400x CATL 5.4 kWh modules", location: "Rotterdam", price: "Ask: €95 / kWh delivered" }, "x");
    expect(line.facts).toEqual(["selling", "2.2 MWh", "€95/kWh", "Rotterdam"]);
    expect(line.closed).toBe(true);
  });
  it("falls back to the stored label when the deal can't be read", () => {
    expect(dealLine(null, "120 new LG Energy Solution EM048128P6BA NMC… · 120 modules").name).toBe("120 new LG Energy Solution EM048128P6BA NMC");
  });
});

describe("shortPlace and lot energy", () => {
  it("shortens an address to the town and country", () => {
    expect(shortPlace("9528 W Interstate 40 Service Rd, Oklahoma City, OK, United States")).toBe("Oklahoma City, United States");
    expect(shortPlace("Megavaux House, Station Road, Sandiacre, Nottingham, NG10 5AP, UK")).toBe("Sandiacre, UK");
    expect(shortPlace("Delivery: STN Power Systems Ltd, Workshop 10, Washington Business Centre, 2 Turbine Way, Sunderland, SR5 3NZ")).toBe("Sunderland");
    expect(shortPlace("Belfast, UK (BT3 9DT)")).toBe("Belfast, UK");
    expect(shortPlace("Dallas, USA")).toBe("Dallas, USA");
  });
  it("gives no total for a capacity range, and counts MWh units", () => {
    const d = (title: string, quantity: string) => dealLine({ kind: "supply", summary: "", quantity, status: "open", title }, "").facts;
    expect(d("15x Renault Zoe 41-52kWh, Citroën e-c3 44kWh", "15 packs")).toEqual(["selling"]);
    expect(d("2x BYD 1.26MWh BESS Containers (Unused)", "2 containers")).toEqual(["selling", "2.5 MWh"]);
  });
  it("keeps a long quantity to its first clause", () => {
    expect(dealLine({ kind: "demand", summary: "Scrap batteries", quantity: "First order 20 tonnes; 150 tonnes a month once running", status: "open" }, "").facts)
      .toEqual(["buying", "First order 20 tonnes"]);
  });
});

