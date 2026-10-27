import { describe, expect, it } from "vitest";
import { amountsIn, beforeYouSend, normaliseAmount, promisesIn } from "./relay-checks";

const facts = { amounts: ["£480", "€30"], participants: ["lubomir@vojta.cz"], unit: "kwh" as const };

describe("relay checks", () => {
  it("normalises amounts", () => {
    expect(normaliseAmount("£1,500.00")).toBe("£1500");
    expect(normaliseAmount("£480,")).toBe("£480");
    expect(normaliseAmount("€30k")).toBe("€30000");
    expect(amountsIn("It's £480, plus €30/kWh and £480 again")).toEqual(["£480", "€30"]);
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
