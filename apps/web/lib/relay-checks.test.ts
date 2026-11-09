import { describe, expect, it } from "vitest";
import { amountsIn, beforeYouSend, moneyIn, normaliseAmount, promisesIn, senderRuleMatch } from "./relay-checks";

const facts = { amounts: ["£480", "€30"], participants: ["lubomir@vojta.cz"], unit: "kwh" as const };

describe("relay checks", () => {
  it("normalises amounts", () => {
    expect(normaliseAmount("£1,500.00")).toBe("£1500");
    expect(normaliseAmount("£480,")).toBe("£480");
    expect(normaliseAmount("€30k")).toBe("€30000");
    expect(amountsIn("It's £480, plus €30/kWh and £480 again")).toEqual(["£480", "€30"]);
  });
  it("keeps money figures as written", () => {
    expect(moneyIn("Between £1,200 and £2,000. Then €30k, or £1,200.")).toEqual(["£1,200", "£2,000", "€30k"]);
    expect(moneyIn("no figures")).toEqual([]);
  });
  it("asks whether a reply is still needed after contact elsewhere", () => {
    const v = beforeYouSend({ to: ["lubomir@vojta.cz"], body: "Shipping is £480.", attachments: 0 }, { ...facts, since: ["call with them on 20 Oct 2026", "a", "b", "c"] });
    expect(v.state).toBe("check");
    expect(v.issues.map((i) => i.text)).toEqual(["Since this email: call with them on 20 Oct 2026; a; b. Check a reply is still needed."]);
    expect(beforeYouSend({ to: ["lubomir@vojta.cz"], body: "Shipping is £480.", attachments: 0 }, { ...facts, since: [] }).state).toBe("ok");
  });
  it("is all clear for a clean draft", () => {
    const v = beforeYouSend({ to: ["lubomir@vojta.cz"], body: "Shipping is £480.", attachments: 0 }, facts);
    expect(v.state).toBe("ok");
  });
  it("blocks a stranger, a missing recipient and blanks", () => {
    expect(beforeYouSend({ to: ["someone@else.com"], body: "Hi", attachments: 0 }, facts).state).toBe("stop");
    expect(beforeYouSend({ to: [], body: "Hi", attachments: 0 }, facts).state).toBe("stop");
    expect(beforeYouSend({ to: ["lubomir@vojta.cz"], body: "Price is [BLANK]", attachments: 0 }, facts).state).toBe("stop");
  });
  it("accepts a colleague on the same domain", () => {
    expect(beforeYouSend({ to: ["office@vojta.cz"], body: "Hi", attachments: 0 }, facts).state).toBe("ok");
  });
  it("flags unknown numbers and units", () => {
    const v = beforeYouSend({ to: ["lubomir@vojta.cz"], body: "It's £520 per cell.", attachments: 0 }, facts);
    expect(v.state).toBe("check");
    expect(v.issues.map((i) => i.text).join(" ")).toMatch(/£520.*per kWh/s);
  });
  it("blocks 'attached' with nothing attached", () => {
    expect(beforeYouSend({ to: ["lubomir@vojta.cz"], body: "List attached.", attachments: 0 }, facts).state).toBe("stop");
    expect(beforeYouSend({ to: ["lubomir@vojta.cz"], body: "List attached.", attachments: 1 }, facts).state).toBe("ok");
  });
  it("finds promises", () => {
    expect(promisesIn("Thanks. I'll send the stock list tomorrow. We will confirm by Friday.")).toEqual(["Send the stock list tomorrow", "Confirm by Friday"]);
  });
});

import { NEEDS_AGENT } from "./relay-checks";
describe("NEEDS_AGENT", () => {
  it("sends work to the agent and words to the quick draft", () => {
    expect(NEEDS_AGENT.test("research our battery supply for LFP and make a csv")).toBe(true);
    expect(NEEDS_AGENT.test("attach the Ioniq 5 stock list")).toBe(true);
    expect(NEEDS_AGENT.test("thank him, offer €38, ask for volumes")).toBe(false);
    expect(NEEDS_AGENT.test("say the price has gone up, still keen?")).toBe(false);
  });
});

describe("senderRuleMatch", () => {
  it("matches a company by domain and free mail by address", () => {
    expect(senderRuleMatch("Tom@Dealer.no")).toBe("@dealer.no");
    expect(senderRuleMatch("jan.novak@seznam.cz")).toBe("jan.novak@seznam.cz");
  });
  it("makes no rule for our own people or a missing address", () => {
    expect(senderRuleMatch("ari@rebattery.io")).toBeNull();
    expect(senderRuleMatch(null)).toBeNull();
    expect(senderRuleMatch("nobody")).toBeNull();
  });
});
