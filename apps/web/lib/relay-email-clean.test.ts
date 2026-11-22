import { describe, expect, it } from "vitest";
import { boldSpans, cleanEmail, emailParagraphs, firstLine } from "./relay-email-clean";

const FABIANO = `Hi Alex,

Do you perhaps have any news or updates regarding the LG batteries I am looking to sell?

Thank you in advance for your feedback. I look forward to hearing from you.

Kind Regards,

Fabiano Solari

Sales Consultant

Easy Energy Companies & Consulting SA

Phone. +41
 91 930 67 03

We proudly represent:

CONFIDENTIALITY : This e-mail and any attachments are confidential and may be privileged. If you are not
 a named recipient, please notify the sender immediately and do not disclose the contents to another person, use it for any purpose or store or copy the information in any medium.`;

describe("cleanEmail", () => {
  it("keeps the message, the sign-off and the name, and drops the signature block and disclaimer", () => {
    expect(cleanEmail(FABIANO)).toBe(`Hi Alex,

Do you perhaps have any news or updates regarding the LG batteries I am looking to sell?

Thank you in advance for your feedback. I look forward to hearing from you.

Kind Regards,

Fabiano Solari`);
  });
  it("drops a quoted reply and a phone footer", () => {
    const text = "Yes, still available.\n\nThanks!\nBen\n\nSent from my iPhone\n\nOn Mon, 2 Nov 2026 at 10:00, Alex <alex@rebattery.io> wrote:\n> Is it still available?";
    expect(cleanEmail(text)).toBe("Yes, still available.\n\nThanks!\nBen");
  });
  it("keeps a sentence of thanks in the body: only a line that is just a sign-off counts", () => {
    const text = "Thank you for the photos, they look good.\nCan you send the test report?\n\nBest regards,\nAnna Kowalska\nHead of Purchasing\n+48 600 100 200";
    expect(cleanEmail(text)).toBe("Thank you for the photos, they look good.\nCan you send the test report?\n\nBest regards,\nAnna Kowalska");
  });
  it("drops the line under a sign-off when it isn't a name", () => {
    expect(cleanEmail("Price is fine.\n\nRegards,\nsales@acme.example | +44 1234 567890")).toBe("Price is fine.\n\nRegards,");
  });
  it("handles foreign sign-offs and a -- signature line", () => {
    expect(cleanEmail("Wir haben 20 Packs.\n\nMit freundlichen Grüßen\nJonas Weber\nEinkauf")).toBe("Wir haben 20 Packs.\n\nMit freundlichen Grüßen\nJonas Weber");
    expect(cleanEmail("See attached.\n--\nTom\nGreenCell Ltd")).toBe("See attached.");
  });
  it("leaves an email with no sign-off whole, with the gaps squeezed", () => {
    expect(cleanEmail("Line one.\n\n\n\nLine two.")).toBe("Line one.\n\nLine two.");
  });
  it("drops a quoted reply whatever language the attribution line is in", () => {
    expect(cleanEmail("Pls refer to the attached photos.\n\nDaniel Han\n\n2026년 11월 13일 (금) 오후 9:22, Alex Polglase <alex@rebattery.io>님이 작성:\n> Hi Daniel")).toBe("Pls refer to the attached photos.\n\nDaniel Han");
    expect(cleanEmail("Hello Alex, do you have some news please?\nLubomír\n\nDne pá 13. 11. 2026 11:45 uživatel Lubomír Vojta <vojtalubomir@gmail.com>\nnapsal:\n> Yes")).toBe("Hello Alex, do you have some news please?\nLubomír");
    expect(cleanEmail("Danke!\n\nAm Mo., 2. Nov. 2026 um 10:00 Uhr schrieb Alex <alex@rebattery.io>:\n> Hallo")).toBe("Danke!");
    expect(cleanEmail("Ok\n\nDa: Alex Polglase <alex@rebattery.io>\nInviato: venerdì 20 novembre 2026 12:37\nA: Nicolò")).toBe("Ok");
    expect(cleanEmail("He wrote: the packs are fine.")).toBe("He wrote: the packs are fine.");
  });
  it("drops inline picture placeholders", () => {
    expect(cleanEmail("[image]\nThe modules are ready.\n[cid:logo.png@01D]\n\nKind regards,\nFabiano")).toBe("The modules are ready.\n\nKind regards,\nFabiano");
  });
  it("splits paragraphs on blank lines only", () => {
    expect(emailParagraphs("Hi,\n\nA\nB\n\nKind regards,\nBen")).toEqual(["Hi,", "A\nB", "Kind regards,\nBen"]);
  });
});

describe("firstLine", () => {
  it("skips the greeting", () => {
    expect(firstLine("Hi Ben,\n\nGreat, the 82 kWh pack is yours. Collection on Friday works.\n\nBest,\nAlex")).toBe("Great, the 82 kWh pack is yours. Collection on Friday works.");
    expect(firstLine("Dear Mr Polglase,\nPlease find attached our offer.")).toBe("Please find attached our offer.");
  });
});

describe("boldSpans", () => {
  it("shows Gmail's *bold* as bold, without the stars", () => {
    expect(boldSpans("- *Exact CALB model / part number:* L135F72")).toEqual([{ text: "- ", bold: false }, { text: "Exact CALB model / part number:", bold: true }, { text: " L135F72", bold: false }]);
    expect(boldSpans("*1. Cell Data*")).toEqual([{ text: "1. Cell Data", bold: true }]);
  });
  it("leaves stars that aren't bold marks", () => {
    expect(boldSpans("Price is 3 * 100 = 300, rated 5*")).toEqual([{ text: "Price is 3 * 100 = 300, rated 5*", bold: false }]);
    expect(boldSpans("a*b*c")).toEqual([{ text: "a*b*c", bold: false }]);
  });
});

