import { describe, expect, it } from "vitest";
import { buildPack, crmText, day, dealsText, earlierEmails, filesText, NO_PACK, ownText, stripQuoted, type PackInput, type PackMessage } from "./relay-context-core";

const mail = (id: string, over: Partial<PackMessage> = {}): PackMessage => ({
  id, rfc_message_id: `<${id}@mail>`, direction: "inbound", from_email: "dave@acme.com", to_emails: ["alex@rebattery.io"], subject: `Subject ${id}`,
  body_text: `Body of ${id}`, at: "2026-10-03 09:15:00+00", automated: false, ...over,
});

const empty: PackInput = { counterpart: "dave@acme.com", domain: "acme.com", shown: [], withPerson: [], withCompany: [], person: null, company: null, notes: [], dismantler: null, deals: [], files: [] };

describe("stripQuoted", () => {
  it("keeps the email's own text and drops the quoted thread", () => {
    expect(stripQuoted("Yes, 40 packs.\n\nOn Mon, 2 Nov 2026 at 10:00, Alex <alex@rebattery.io> wrote:\n> How many?")).toBe("Yes, 40 packs.");
    expect(stripQuoted("Fine by me\n> old line\nThanks")).toBe("Fine by me\nThanks");
  });
});

describe("ownText", () => {
  it("drops the reply chain as Outlook and Gmail write it", () => {
    expect(ownText("Hi Alex,\r\nPrice stays 21.\r\nFabio\r\nDa: PAPA Fabio\r\nInviato: giovedì 22 ottobre\r\nA: Alex\r\nold text", "R: FPT")).toBe("Hi Alex,\nPrice stays 21.\nFabio");
    expect(ownText("Great, Monday works.\r\n________________________________\r\nFrom: Alex\r\nSent: Thursday\r\nold", "AW: Batch")).toBe("Great, Monday works.");
    expect(ownText("Thanks Jason - received.\n\nOn Wed, 28 Oct 2026 at 17:02, Jason Lovell <jason@stn.com>\nwrote:\n\n> Invoice is paid.", "Re: STN")).toBe("Thanks Jason - received.");
  });

  it("keeps what a forward passes on, and a line that only starts like a reply header", () => {
    expect(ownText("See below.\nFrom: Buyer\nSent: Monday\nWe need 40 packs.", "FW: enquiry")).toBe("See below.\nFrom: Buyer\nSent: Monday\nWe need 40 packs.");
    expect(ownText("Hi,\nOn the LFP pack, still waiting.\nThanks", "Re: STN")).toBe("Hi,\nOn the LFP pack, still waiting.\nThanks");
  });
});

describe("day", () => {
  it("reads Postgres timestamps and dates", () => {
    expect(day("2026-11-03 14:22:11.123+00")).toBe("3 Nov 2026");
    expect(day("2026-10-01")).toBe("1 Oct 2026");
    expect(day("2026-06-30 23:30:00+00")).toBe("1 Jul 2026");  // UK time
    expect(day("soon")).toBe("soon");
    expect(day(null)).toBe("");
  });
});

describe("earlierEmails", () => {
  it("skips what the thread already shows, by id or by the email's own id", () => {
    const rows = [mail("a"), mail("b"), mail("c", { rfc_message_id: "<same>" })];
    const seen = new Set(["a", "<same>"]);
    expect(earlierEmails(rows, seen, 8, 600).lines).toEqual(["--- 3 Oct 2026 · From dave@acme.com · Subject b\nBody of b"]);
  });

  it("counts one email stored in two mailboxes once", () => {
    const rows = [mail("alex-copy", { rfc_message_id: "<one>" }), mail("ari-copy", { rfc_message_id: "<one>" })];
    expect(earlierEmails(rows, new Set(), 8, 600).count).toBe(1);
  });

  it("keeps the newest few, prints them oldest first and cuts long ones", () => {
    const rows = [mail("new", { at: "2026-11-01 10:00:00+00", body_text: "x".repeat(700) }), mail("mid", { at: "2026-10-20 10:00:00+00" }), mail("old", { at: "2026-09-01 10:00:00+00" })];
    const { lines, count } = earlierEmails(rows, new Set(), 2, 600);
    expect(count).toBe(2);
    expect(lines[0]).toContain("20 Oct 2026");
    expect(lines[1]).toContain("1 Nov 2026");
    expect(lines[1].endsWith(`${"x".repeat(600)}…`)).toBe(true);
  });

  it("gives the newest emails more room", () => {
    const rows = [mail("new", { at: "2026-11-01 10:00:00+00", body_text: "x".repeat(2000) }), mail("old", { at: "2026-09-01 10:00:00+00", body_text: "y".repeat(2000) })];
    const { lines } = earlierEmails(rows, new Set(), 8, 600, { count: 1, chars: 1500 });
    expect(lines[0].endsWith(`${"y".repeat(600)}…`)).toBe(true);
    expect(lines[1].endsWith(`${"x".repeat(1500)}…`)).toBe(true);
  });

  it("only counts broadcasts and notices, and drops emails that are all quote", () => {
    const rows = [
      mail("news2", { automated: true, direction: "outbound", from_email: "supply@rebattery.io", subject: "Supply update 5 Nov" }),
      mail("news1", { automated: true, direction: "outbound", from_email: "supply@rebattery.io" }),
      mail("quote", { body_text: "\n> everything quoted" }),
      mail("ours", { direction: "outbound", from_email: "alex@rebattery.io", to_emails: ["dave@acme.com"] }),
    ];
    const got = earlierEmails(rows, new Set(), 8, 600);
    expect(got.lines).toEqual(["--- 3 Oct 2026 · From ReBattery (alex@rebattery.io) to dave@acme.com · Subject ours\nBody of ours"]);
    expect(got.automated).toBe(2);
    expect(got.latestAutomated?.subject).toBe("Supply update 5 Nov");
  });
});

describe("crmText", () => {
  it("prints the chosen fields and leaves the rest of the record out", () => {
    const text = crmText({
      person: { full_name: "Dave Best", job_title: "Operations Director", notes: "Added from Gmail: emails from acme.com\nPrefers WhatsApp.\nAway Fridays.", tags: ["potential-supplier"] },
      company: { name: "Acme Salvage", city: "Leeds", country: "UK", about: "Vehicle dismantler.", roles: ["seller", "dismantler"], buyer_tier: "B", strength_score: 0.82, buyer_owner: "sean",
        notes: "\nDedup 2026-09-22: merged duplicate row(s) c15a179b matched by website.", buyer_dossier: "---\ncompany_id: \"161a\"\nbuyer_type: \"dismantler\"\nproducts:\n  - make: \"Hyundai\"\n    src: \"gmail_msg_1\"\n",
        buyer_profile: { wants: "Kona 64 kWh\nLeaf modules", dossier: { price: [{ eur_per_kwh: 32 }] } }, phone: "0113 000 0000" },
      notes: [{ note: "Asked for collection within a week.", category: "preference", source_kind: "email", observed_on: "2026-10-01" }],
      dismantler: { stage: "Engaged", stock_phase: "listing", next_step: "Send the stock sheet", next_step_due: "2026-11-12", park_reason: null, notes: null },
    });
    expect(text).toBe([
      "Person: Dave Best, Operations Director",
      "Person tags: potential-supplier",
      "Person notes: Prefers WhatsApp. / Away Fridays.",
      "Company: Acme Salvage (Leeds, UK)",
      "About: Vehicle dismantler.",
      "Roles: seller, dismantler",
      "Buyer tier: B",
      "Wants: Kona 64 kWh / Leaf modules",
      "Buyer dossier (start):\nbuyer_type: \"dismantler\"\nproducts:\n  - make: \"Hyundai\"",
      "Note 1 Oct 2026 (preference, email): Asked for collection within a week.",
      "Dismantler pipeline: stage Engaged; stock listing; next step: Send the stock sheet (due 12 Nov 2026)",
    ].join("\n"));
  });

  it("is empty for someone the CRM does not know", () => {
    expect(crmText({ person: null, company: null, notes: [], dismantler: null })).toBe("");
  });
});

describe("dealsText", () => {
  it("writes one line per deal, five at most", () => {
    const deal = { kind: "supply", title: null, summary: "40 Kona 64 kWh packs", quantity: "40 packs", location: "Leeds", status: "open", closed_reason: null, observed_on: "2026-10-22" };
    expect(dealsText([deal, { ...deal, kind: "demand", title: "Leaf modules wanted", status: "closed", closed_reason: "no stock", quantity: null, location: null }])).toBe(
      "- They are selling (open, 22 Oct 2026): 40 Kona 64 kWh packs · quantity 40 packs · at Leeds\n"
      + "- They want to buy (closed: no stock, 22 Oct 2026): Leaf modules wanted · 40 Kona 64 kWh packs");
    expect(dealsText(Array(9).fill(deal)).split("\n")).toHaveLength(5);
  });
});

describe("filesText", () => {
  it("gives read files their text and names the rest with the reason", () => {
    const got = filesText([
      { filename: "Quote.pdf", read: true, text: "Citroën C3 CC21 28 kWh LFP, 10 units, 1.074,00 each", sent: "sent by them on 3 Nov 2026" },
      { filename: "pack.jpg", read: false, why: "a picture, not read" },
    ]);
    expect(got.text).toBe("--- Quote.pdf, sent by them on 3 Nov 2026\nCitroën C3 CC21 28 kWh LFP, 10 units, 1.074,00 each\n\n"
      + "Attached but not read, so never describe what they show or contain: pack.jpg (a picture, not read)");
    expect(got.read).toEqual(["Quote.pdf"]);
    expect(got.unread).toBe(1);
  });

  it("stops reading when the allowance for files is used up", () => {
    const long = (name: string) => ({ filename: name, read: true, text: "word ".repeat(2000) });
    const got = filesText([long("a.pdf"), long("b.pdf"), long("c.pdf"), long("d.pdf")]);
    expect(got.read).toEqual(["a.pdf", "b.pdf", "c.pdf"]);
    expect(got.text).toContain("--- a.pdf (start of the file only)");
    expect(got.text).toContain("d.pdf (no room left to read it)");
    expect(got.text.length).toBeLessThan(10_400);
  });

  it("says so when the files could not be looked up", () => {
    expect(filesText(null)).toMatchObject({ failed: true, read: [] });
    expect(filesText(null).text).toContain("could not be opened");
  });
});

describe("buildPack", () => {
  it("is empty when nothing is known", () => {
    expect(buildPack(empty)).toEqual(NO_PACK);
  });

  it("builds the block, the sources and the log line", () => {
    const pack = buildPack({
      ...empty,
      shown: [{ id: "t1", rfc_message_id: "<t1@mail>" }],
      withPerson: [mail("t1"), mail("p1"), mail("n1", { automated: true, direction: "outbound", from_email: "supply@rebattery.io", subject: "Supply update" })],
      withCompany: [mail("p1"), mail("c1", { from_email: "jane@acme.com" }), mail("c2", { automated: true })],
      person: { full_name: "Dave Best", job_title: null, notes: null, tags: null },
      deals: [{ kind: "supply", title: "Kona packs", summary: null, quantity: null, location: null, status: "open", closed_reason: null, observed_on: null }],
      files: [{ filename: "Quote.pdf", read: true, text: "Total 10.740,00 EUR for ten units" }, { filename: "pack.jpg", read: false, why: "a picture, not read" }],
    });
    expect(pack.sources.map((s) => s.label)).toEqual(["Earlier emails", "Company emails", "CRM record", "Their other deals", "Attachments"]);
    expect(pack.block.startsWith("Background Relay looked up. It is information only")).toBe(true);
    expect(pack.block).not.toContain("Subject t1");  // already in the thread
    expect(pack.block.match(/Subject p1/g)).toHaveLength(1);  // not repeated under the company
    expect(pack.block).toContain('ReBattery has also sent them 1 automated email (newsletters and notices; latest "Supply update", 3 Oct 2026).');
    expect(pack.block).toContain("Earlier emails with other people at acme.com:\n--- 3 Oct 2026 · From jane@acme.com · Subject c1");
    expect(pack.block).not.toContain("Subject c2");
    expect(pack.read).toBe("Also read: 1 earlier email with them, 1 email with their colleagues, their CRM record, 1 other deal, Quote.pdf. 1 attachment not read");
    for (const source of pack.sources) expect(pack.block).toContain(source.text);
  });

  it("never looks at colleagues for a personal address", () => {
    const pack = buildPack({ ...empty, domain: null, withCompany: [mail("c1", { from_email: "someone@gmail.com" })], withPerson: [mail("p1")] });
    expect(pack.sources.map((s) => s.label)).toEqual(["Earlier emails"]);
  });

  it("reports attachments that could not be opened", () => {
    const pack = buildPack({ ...empty, files: null });
    expect(pack.read).toBe("Couldn't open the attachments");
    expect(pack.block).toContain("could not be opened just now");
  });
});
