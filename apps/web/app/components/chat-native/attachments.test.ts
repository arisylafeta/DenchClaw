import { describe, expect, it } from "vitest";
import { parseUserAttachments } from "./attachments";

describe("parseUserAttachments", () => {
  it("separates the CRM prefix, Hermes staging lines and the message", () => {
    const text = "[Attached files: assets/1792339092104-Matcha_Puzzle_Gecko_Detective.png]\n\nuse this image as its profile\n@image:/root/.hermes/images/upload_20261018_155819_1.png\n[screenshot]";
    expect(parseUserAttachments(text)).toEqual({ message: "use this image as its profile", attachments: [{ path: "assets/1792339092104-Matcha_Puzzle_Gecko_Detective.png", name: "1792339092104-Matcha_Puzzle_Gecko_Detective.png", image: true }] });
  });
  it("shows a staged image when there is no CRM prefix, and non-images as files", () => {
    expect(parseUserAttachments("look\n@image:/x/up_1.png")).toMatchObject({ message: "look", attachments: [{ name: "up_1.png", image: true }] });
    expect(parseUserAttachments("[Attached files: docs/a.pdf, docs/b.png] hi")).toMatchObject({ message: "hi", attachments: [{ name: "a.pdf", image: false }, { name: "b.png", image: true }] });
  });
  it("leaves ordinary text alone", () => {
    expect(parseUserAttachments("plain [text] with @image: mid-line")).toEqual({ message: "plain [text] with @image: mid-line", attachments: [] });
  });
});
