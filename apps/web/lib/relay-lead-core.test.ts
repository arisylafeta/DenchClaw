import { describe, expect, it } from "vitest";
import { assembleLead, asksFor, checkLeadReply, cleanAnswer, cleanLeadState, EMPTY_STATE, leadChips, leadFirstName, numbersKnown, priceWarning, questionId, quoteIn, verifyLead,
  type LeadData, type LeadState } from "./relay-lead-core";

// A made-up seller lead in the shape of the real ones: a broker with a lot overseas, three standard questions.
const EMAIL = `Hi Alex,

We have been asked to find a home for 1,200 used LFP modules from a storage site in Texas. They were in service for about four years and are still operational. The site has to be clear by the end of March.

Can we work on a non-exclusive basis? Do you have buyers in North America? And how do you work, and what do you charge?

Photos attached.

Regards,
Jordan Reyes
Northgate Asset Recovery`;

const READ = {
  kind: "seller_lead", lot: "bulk", why: "1,200 modules from a storage site", unit: "modules", role: "broker", role_quote: "We have been asked to find a home",
  summary: "A broker has 1,200 used LFP modules from a Texas storage site to clear by the end of March.",
  facts: [
    { key: "what", value: "Used LFP modules", quote: "used LFP modules" },
    { key: "how_many", value: "1,200 modules", quote: "1,200 used LFP modules" },
    { key: "where", value: "Texas", quote: "a storage site in Texas" },
    { key: "condition", value: "Operational", quote: "still operational" },
    { key: "when", value: "End of March", quote: "clear by the end of March" },
  ],
  asked: [
    { topic: "non_exclusive", quote: "Can we work on a non-exclusive basis?" },
    { topic: "buyers", region: "north_america", quote: "Do you have buyers in North America?" },
    { topic: "how_we_work", quote: "how do you work, and what do you charge?" },
  ],
  other_questions: [],
};

function dataFrom(raw: Record<string, unknown>, email = EMAIL, over: Partial<LeadData> = {}): LeadData {
  const r = verifyLead(raw, email);
  return {
    side: r.kind === "buyer_lead" ? "buyer" : "seller", unit: r.unit, role: r.role, firstName: leadFirstName("Jordan Reyes", "jordan@northgate.example", email),
    summary: r.summary ?? "", facts: r.facts, asked: r.asked, other: r.other, have: r.facts.map((f) => f.key), sent: "photos", deal: false,
    email: { subject: "Used LFP modules", text: email, at: "2026-11-08T18:26:00Z", files: [] }, ...over,
  };
}
const SENDER = { name: "Jordan Reyes", email: "jordan@northgate.example" };
const state = (over: Partial<LeadState> = {}): LeadState => ({ ...EMPTY_STATE, ...over });
const ANSWERS = {
  non_exclusive: "Happy to work on a non-exclusive basis.",
  "buyers:north_america": "On buyers: yes, we work with second-life buyers in North America.",
  how_we_work: "How it works: we list the lot on our marketplace and take it to buyers directly. Our commission is 10% of the sale price.",
};

describe("quoteIn and numbersKnown", () => {
  it("finds a quote whatever the spacing, case and quote marks", () => {
    expect(quoteIn("can we work on a  NON-EXCLUSIVE basis", EMAIL)).toBe(true);
    expect(quoteIn("“it’s fine”", "She said \"it's fine\" twice")).toBe(true);
  });
  it("needs the words to be there, and more than a couple of characters", () => {
    expect(quoteIn("we own the modules", EMAIL)).toBe(false);
    expect(quoteIn("Hi", EMAIL)).toBe(false);
    expect(quoteIn(undefined, EMAIL)).toBe(false);
  });
  it("reads 1,200 and 1200 as the same number, and misses a number that is not written", () => {
    expect(numbersKnown("1200 modules", EMAIL)).toBe(true);
    expect(numbersKnown("1,250 modules", EMAIL)).toBe(false);
    expect(numbersKnown("No figure", EMAIL)).toBe(true);
  });
});

describe("verifyLead", () => {
  it("keeps what the email backs", () => {
    const r = verifyLead(READ, EMAIL);
    expect(r.kind).toBe("seller_lead");
    expect(r.role).toBe("broker");
    expect(r.facts.map((f) => f.key)).toEqual(["what", "how_many", "where", "condition", "when"]);
    expect(r.asked.map(questionId)).toEqual(["non_exclusive", "buyers:north_america", "how_we_work"]);
    expect(r.summary).toContain("1,200");
  });
  it("drops a fact whose quote is not in the email, or whose number is not", () => {
    const r = verifyLead({ ...READ, facts: [
      { key: "price", value: "$40 per kWh", quote: "asking $40 per kWh" },
      { key: "how_many", value: "1,500 modules", quote: "1,200 used LFP modules" },
      { key: "health", value: "92% health", quote: "still operational" },
      { key: "colour", value: "Blue", quote: "used LFP modules" },
      { key: "where", value: "Texas", quote: "a storage site in Texas" },
      { key: "where", value: "Storage site", quote: "a storage site in Texas" },
    ] }, EMAIL);
    expect(r.facts).toEqual([{ key: "where", value: "Texas" }]);
  });
  it("keeps a fact that only an attachment backs", () => {
    const raw = { ...READ, facts: [{ key: "health", value: "92% health", quote: "State of health 92%" }] };
    expect(verifyLead(raw, EMAIL).facts).toEqual([]);
    expect(verifyLead(raw, EMAIL, "Report\nState of health 92%").facts).toEqual([{ key: "health", value: "92% health" }]);
  });
  it("does not take the role on trust", () => {
    expect(verifyLead({ ...READ, role: "owner", role_quote: "these are our own modules" }, EMAIL).role).toBe("unknown");
    expect(verifyLead({ ...READ, role: "wizard", role_quote: "We have been asked" }, EMAIL).role).toBe("unknown");
  });
  it("drops questions they did not ask, unknown topics, unknown regions and repeats", () => {
    const r = verifyLead({ ...READ, asked: [
      { topic: "non_exclusive", quote: "Can we work on a non-exclusive basis?" },
      { topic: "non_exclusive", quote: "non-exclusive basis" },
      { topic: "collection", quote: "Can you collect from Texas?" },
      { topic: "discount", quote: "what do you charge?" },
      { topic: "buyers", region: "mars", quote: "Do you have buyers in North America?" },
      { topic: "buyers", quote: "Do you have buyers in North America?" },
    ] }, EMAIL);
    expect(r.asked.map(questionId)).toEqual(["non_exclusive"]);
  });
  it("keeps up to four other questions, each found in the email", () => {
    const r = verifyLead({ ...READ, other_questions: [{ quote: "what do you charge?" }, { quote: "Is your office open on Sunday?" }, { quote: "Hi" }] }, EMAIL);
    expect(r.other).toEqual([{ id: "other:1", quote: "what do you charge?" }]);
  });
  it("drops a summary that carries a number of its own, and reads nonsense as not a lead", () => {
    expect(verifyLead({ ...READ, summary: "A broker has 2,000 modules in Texas." }, EMAIL).summary).toBeNull();
    const r = verifyLead({ kind: "spam", lot: "huge", facts: "none", asked: null }, EMAIL);
    expect([r.kind, r.lot, r.unit, r.role, r.facts.length, r.asked.length]).toEqual(["other", "unclear", "modules", "unknown", 0, 0]);
  });
});

describe("assembleLead", () => {
  it("first time: a blue question for each thing they asked, and Send waits", () => {
    const reply = assembleLead(dataFrom(READ), state(), {});
    expect(reply.open).toEqual(["non_exclusive", "buyers:north_america", "how_we_work"]);
    expect(reply.blocks.filter((b) => b.kind === "question").map((b) => (b.kind === "question" ? b.prompt : ""))).toEqual([
      "Jordan asked if we can work on a non-exclusive basis.", "Jordan asked if we have buyers in North America.", "Jordan asked how we work and what we charge."]);
    // Nothing they asked is answered for Alex, and the fixed parts carry no figure.
    expect(reply.body.replace("UN38.3", "")).not.toMatch(/non-exclusive|commission|On buyers|\d|[€£$]/);
    expect(reply.body.startsWith("Hi Jordan,\n\nThanks for the details and the photos.")).toBe(true);
    expect(reply.body.endsWith("Best,\nAlex")).toBe(true);
    expect(checkLeadReply(reply, dataFrom(READ), SENDER)).toEqual(["A blue question is still unanswered."]);
  });
  it("asks only for what is missing, with the broker's wording on price", () => {
    const reply = assembleLead(dataFrom(READ), state(), ANSWERS);
    expect(reply.asks.map((a) => a.key)).toEqual(["owner", "price", "health", "storage", "un38", "docs"]);
    expect(reply.body).toContain("To put it in front of buyers, please send the datasheet and any test reports with their dates, and let me know:\n- Who the owner is\n- The owner's asking price, per module or per kWh\n- Health per module, or which ones are untested");
    expect(reply.body).not.toMatch(/How many there are|Where they are|When the lot needs/);
    expect(reply.cover).toEqual({ text: "✓ Nothing missing for the deal card is left unasked", tone: "ok" });
  });
  it("uses saved answers word for word, in the mockup's order, and is ready to send", () => {
    const data = dataFrom(READ);
    const reply = assembleLead(data, state(), ANSWERS);
    expect(reply.open).toEqual([]);
    const paras = reply.body.split("\n\n");
    expect(paras[1]).toBe(`Thanks for the details and the photos. ${ANSWERS.non_exclusive}`);
    expect(paras[2]).toBe(ANSWERS["buyers:north_america"]);
    expect(paras[3]).toBe(ANSWERS.how_we_work);
    const answers = reply.blocks.flatMap((b) => (b.kind === "para" ? b.spans.filter((s) => s.answer) : []));
    expect(answers.map((s) => s.answer)).toEqual([{ id: "non_exclusive", saved: true }, { id: "buyers:north_america", saved: true }, { id: "how_we_work", saved: true }]);
    expect(checkLeadReply(reply, data, SENDER)).toEqual([]);
  });
  it("a pick on the card beats the saved answer, and Leave it out removes the line", () => {
    const reply = assembleLead(dataFrom(READ), state({ picks: { non_exclusive: { text: "Non-exclusive works for us." }, how_we_work: { text: null } } }), ANSWERS);
    expect(reply.body).toContain("Thanks for the details and the photos. Non-exclusive works for us.");
    expect(reply.body).not.toContain(ANSWERS.non_exclusive);
    expect(reply.body).not.toContain("How it works");
    expect(reply.open).toEqual([]);
  });
  it("Change reopens a saved answer and offers to keep it", () => {
    const reply = assembleLead(dataFrom(READ), state({ reopened: ["how_we_work"] }), ANSWERS);
    expect(reply.open).toEqual(["how_we_work"]);
    const q = reply.blocks.find((b) => b.kind === "question");
    expect(q?.kind === "question" && q.options[0]).toEqual({ label: "Keep my saved answer", line: ANSWERS.how_we_work });
    expect(reply.body).not.toContain("How it works");
  });
  it("× stops an ask, and warns when the deal needs it", () => {
    const soft = assembleLead(dataFrom(READ), state({ off: ["storage", "un38"] }), ANSWERS);
    expect(soft.body).not.toMatch(/stored|UN38/);
    expect(soft.cover).toEqual({ text: "✓ Deal card covered · not asking Storage, UN38.3", tone: "ok" });
    const hard = assembleLead(dataFrom(READ), state({ off: ["price", "docs"] }), ANSWERS);
    expect(hard.body).not.toMatch(/asking price|datasheet/);
    expect(hard.body).toContain("To put it in front of buyers, please let me know:");
    expect(hard.cover).toEqual({ text: "! Not asking price: the deal can't go to buyers without it", tone: "warn" });
  });
  it("asks for nothing when they sent it all", () => {
    const all = asksFor("seller", "modules", "broker").map((a) => a.key);
    const reply = assembleLead(dataFrom(READ, EMAIL, { have: all }), state(), ANSWERS);
    expect(reply.blocks.some((b) => b.kind === "asks")).toBe(false);
    expect(reply.cover.text).toBe("✓ They sent everything the deal card needs");
  });
  it("never offers a seller a price: the fixed rule, in the owner's or the broker's wording", () => {
    const email = `${EMAIL}\nWhat price can you offer?`;
    const raw = { ...READ, asked: [{ topic: "pricing", quote: "What price can you offer?" }] };
    const broker = assembleLead(dataFrom(raw, email), state(), {});
    expect(broker.body).toContain("On price, we'd rather start from the owner's figure than guess one.");
    expect(broker.open).toEqual([]);
    const owner = assembleLead(dataFrom({ ...raw, role: "unknown" }, email), state(), {});
    expect(owner.body).toContain("On price, we'd rather start from your figure than guess one.");
    expect(owner.body).toContain("- Your asking price, per module or per kWh");
  });
  it("packs get the pack list, with the health list and label photos", () => {
    const email = "Hello, we have 40 Tesla Model 3 packs out of the cars in Leeds. Thanks, Sam";
    const raw = { kind: "seller_lead", lot: "bulk", unit: "packs", facts: [{ key: "how_many", value: "40 packs", quote: "40 Tesla Model 3 packs" }, { key: "where", value: "Leeds", quote: "in Leeds" }] };
    const reply = assembleLead(dataFrom(raw, email, { firstName: "Sam", sent: null }), state(), {});
    expect(reply.body).toContain("Hi Sam,\n\nThanks for getting in touch.");
    expect(reply.body).toContain("please send the health list with tag or VIN, and photos of the labels, and let me know:\n- Who owns the packs\n- The make, model and kWh of the packs\n- Your asking price, per pack or per kWh\n- A health reading per pack");
    expect(reply.body).toContain("- Whether they are in the car or out, and any damage");
  });
  it("a buyer lead asks the buyer's questions and treats a price request as a question for Alex", () => {
    const email = "Hello, we need 500 kWh of LFP modules delivered to Poland. Can you send a price? Do you have buyers in Europe? Regards, Ana";
    const raw = { kind: "buyer_lead", lot: "bulk", unit: "modules", facts: [{ key: "what", value: "LFP modules", quote: "LFP modules" }, { key: "how_many", value: "500 kWh", quote: "500 kWh of LFP modules" }, { key: "where", value: "Poland", quote: "delivered to Poland" }],
      asked: [{ topic: "pricing", quote: "Can you send a price?" }, { topic: "buyers", region: "europe", quote: "Do you have buyers in Europe?" }] };
    const data = dataFrom(raw, email, { firstName: "Ana", sent: null });
    const reply = assembleLead(data, state(), {});
    expect(data.side).toBe("buyer");
    // "Do you have buyers" has no fixed part for a buyer: it stays, as a question for Alex.
    expect(reply.open).toEqual(["pricing_buyer", "other:1"]);
    expect(reply.asks.map((a) => a.key)).toEqual(["price", "when", "min_health", "tests"]);
    expect(reply.body).toContain("To find the right stock, please let me know:\n- Your target price, and per what (pack, module, cell or kWh)\n- When you need them by");
    expect(reply.body).not.toMatch(/On buyers|figure than guess/);
    const sent = assembleLead(data, state({ picks: { pricing_buyer: { text: "On price: we quote per lot, once we know exactly what you need." }, "other:1": { text: null } } }), {});
    expect(sent.body).toContain("On price: we quote per lot, once we know exactly what you need.");
    expect(checkLeadReply(sent, data, { name: "Ana Kowalska", email: "ana@buyer.example" })).toEqual([]);
  });
  it("any other question is Alex's to answer, with nothing suggested and nothing remembered", () => {
    const raw = { ...READ, asked: [], other_questions: [{ quote: "what do you charge?" }] };
    const reply = assembleLead(dataFrom(raw), state(), {});
    const q = reply.blocks.find((b) => b.kind === "question");
    expect(q).toEqual({ kind: "question", id: "other:1", prompt: "Jordan asked:", quote: "what do you charge?", options: [], remember: false });
    expect(reply.open).toEqual(["other:1"]);
    expect(assembleLead(dataFrom(raw), state({ picks: { "other:1": { text: "Our fee is a percentage of the sale." } } }), {}).body).toContain("Our fee is a percentage of the sale.");
  });
  it("greets with Hello when there is no name it can stand behind", () => {
    const reply = assembleLead(dataFrom(READ, EMAIL, { firstName: null }), state(), {});
    expect(reply.body.startsWith("Hello,\n\n")).toBe(true);
    expect(reply.blocks.find((b) => b.kind === "question")).toMatchObject({ prompt: "They asked if we can work on a non-exclusive basis." });
  });
});

describe("checkLeadReply and priceWarning", () => {
  it("stops a name their email does not carry, and a reply with nowhere to go", () => {
    const data = dataFrom(READ, EMAIL, { firstName: "Morgan" });
    const reply = assembleLead(data, state(), ANSWERS);
    expect(checkLeadReply(reply, data, { name: "Jordan Reyes", email: "" })).toEqual(["The name \"Morgan\" is not in their email.", "There is no address to reply to."]);
  });
  it("stops a figure in the fixed parts, but not UN38.3 or a figure in Alex's own answer", () => {
    const data = dataFrom(READ);
    expect(checkLeadReply(assembleLead(data, state(), ANSWERS), data, SENDER)).toEqual([]);
    const odd = { ...data, firstName: "Jordan2" };
    expect(checkLeadReply(assembleLead(odd, state(), ANSWERS), odd, SENDER)).toContain("The reply holds a figure Relay did not get from you.");
  });
  it("tells Alex when his own answer to a seller names a price", () => {
    const data = dataFrom(READ);
    const priced = assembleLead(data, state({ picks: { non_exclusive: { text: "Yes, and we could pay around $35 per kWh." } } }), ANSWERS);
    expect(priceWarning(priced, data)).toMatch(/names a price/);
    expect(priceWarning(assembleLead(data, state(), ANSWERS), data)).toBeNull();
  });
});

describe("leadFirstName", () => {
  it("takes a person's first name from the From name", () => {
    expect(leadFirstName("Jordan Reyes", "sales@northgate.example", "")).toBe("Jordan");
    expect(leadFirstName("REYES, Jordan", "j.reyes@northgate.example", "")).toBe("Jordan");
    expect(leadFirstName("jordan", "jordan.reyes@northgate.example", "")).toBe("Jordan");
    expect(leadFirstName("Jordan", "hello@northgate.example", "Stock list below.\n\nBest,\nJordan")).toBe("Jordan");
  });
  it("does not greet a company or a shared inbox by name", () => {
    expect(leadFirstName("ACME Batteries", "sales@acme.example", "Please quote.")).toBeNull();
    expect(leadFirstName("Green Scape", "info@greenscape.example", "Please quote.")).toBeNull();
    expect(leadFirstName("Info", "info@acme.example", "Please quote.")).toBeNull();
    expect(leadFirstName("sales@acme.example", "sales@acme.example", "Please quote.")).toBeNull();
    expect(leadFirstName(null, "x7@acme.example", "")).toBeNull();
    expect(leadFirstName("Northgate", "northgate@mail.example", "We have stock.\n\nNorthgate\nUnit 4")).toBeNull();
  });
  it("falls back to the sign-off", () => {
    expect(leadFirstName("Northgate Sales", "sales@northgate.example", "We have stock.\n\nKind regards,\nMaria\nNorthgate")).toBe("Maria");
    expect(leadFirstName("Northgate", "sales@northgate.example", "We have stock.\n\nThanks,\n\nThe Team")).toBeNull();
  });
});

describe("leadFirstName, sign-offs and role names", () => {
  it("takes a sign-off name only from the line under a sign-off, and only when it reads as a name", () => {
    expect(leadFirstName("", "x7@acme.example", "We want the best\nprice you can offer for these.")).toBeNull();
    expect(leadFirstName("", "x7@acme.example", "Many thanks\nlooking forward to your reply")).toBeNull();
    expect(leadFirstName("", "x7@acme.example", "Thanks,\nPlease let me know")).toBeNull();
    expect(leadFirstName("", "x7@acme.example", "Thanks,\nPlease Advise")).toBeNull();
    expect(leadFirstName("", "x7@acme.example", "Regards,\nGreen Planet Ltd")).toBeNull();
    expect(leadFirstName("", "x7@acme.example", "Best\nRegards\nMaria Silva\nNorthgate")).toBe("Maria");
    expect(leadFirstName("", "x7@acme.example", "Yours sincerely,\n\nMARIA SILVA")).toBe("Maria");
  });
  it("does not greet a role or a company shown as the From name", () => {
    expect(leadFirstName("Customer Service", "help@northgate.example", "Please quote.")).toBeNull();
    expect(leadFirstName("Green Planet", "greenplanet@mail.example", "Please quote.")).toBeNull();
    expect(leadFirstName("Northgate Sales", "sales@northgate.example", "Please quote.")).toBeNull();
  });
  it("prefers the name they signed with over an unbacked From name", () => {
    expect(leadFirstName("Harbour Lane", "office@mail.example", "Stock below.\n\nKind regards,\nMaria")).toBe("Maria");
    expect(leadFirstName("Jordan Reyes", "jordan.reyes@northgate.example", "Stock below.\n\nThanks,\nJ")).toBe("Jordan");
  });
});

describe("verifyLead, a buyer's questions", () => {
  it("keeps a question with no fixed part for a buyer as an open question", () => {
    const email = "Hello, we are looking to buy 40 used LFP modules for a storage project in Leeds. How do you work, and what do you charge? Can you ship to site?";
    const r = verifyLead({ kind: "buyer_lead", lot: "bulk", unit: "modules", facts: [],
      asked: [{ topic: "how_we_work", quote: "How do you work, and what do you charge?" }, { topic: "collection", quote: "Can you ship to site?" }],
      other_questions: [{ quote: "How do you work, and what do you charge?" }] }, email);
    expect(r.asked.map((a) => a.topic)).toEqual(["collection"]);
    expect(r.other).toEqual([{ id: "other:1", quote: "How do you work, and what do you charge?" }]);
  });
});

describe("leadChips", () => {
  it("orders the facts the way the card shows them", () => {
    expect(leadChips(verifyLead(READ, EMAIL).facts)).toEqual(["Used LFP modules", "1,200 modules", "Texas", "Operational", "End of March"]);
  });
});

describe("cleanLeadState", () => {
  const data = dataFrom(READ);
  it("keeps only this card's asks and questions, and cleans the answers", () => {
    const cleaned = cleanLeadState({
      off: ["price", "price", "made_up", 7],
      reopened: ["non_exclusive", "other:9"],
      picks: { non_exclusive: { text: "  Yes,\n happy  to.\u0007 ", remember: true }, how_we_work: { text: "   " }, made_up: { text: "x" }, "buyers:north_america": "yes" },
    }, data);
    expect(cleaned).toEqual({ off: ["price"], reopened: ["non_exclusive"], picks: { non_exclusive: { text: "Yes, happy to.", remember: true }, how_we_work: { text: null, remember: false } } });
    expect(cleanLeadState(null, data)).toEqual(EMPTY_STATE);
  });
  it("gives the same reply for what the page holds and what the server keeps", () => {
    const typed = { off: [], reopened: [], picks: { non_exclusive: { text: cleanAnswer("Yes,   that works\nfor us."), remember: true } } };
    expect(assembleLead(data, cleanLeadState(typed, data), {}).body).toBe(assembleLead(data, typed, {}).body);
  });
  it("lets an unanswered question through only on the way to the editor", () => {
    const reply = assembleLead(data, state(), {});
    const sender = { name: "Jordan Reyes", email: "jordan@northgate.example" };
    expect(checkLeadReply(reply, data, sender)).toContain("A blue question is still unanswered.");
    expect(checkLeadReply(reply, data, sender, true)).toEqual([]);
  });
});
