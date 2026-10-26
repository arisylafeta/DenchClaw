import { describe, expect, it } from "vitest";
import { splitCopy, textToHtml } from "./mail-draft-actions";

describe("draft copy", () => {
  const signature = "Alex Polglase\nFounder & CEO\nrebattery.io | alex@rebattery.io\n";
  it("separates the written copy from the frozen signature", () => {
    expect(splitCopy(`Hi Rick,\n\nThanks,\n\n${signature}`, signature)).toEqual({ main: "Hi Rick,\n\nThanks,", signed: true });
  });
  it("treats everything as copy when the signature is missing or stale", () => {
    expect(splitCopy("Hi\n\nOld signature", signature)).toEqual({ main: "Hi\n\nOld signature", signed: false });
    expect(splitCopy(null, null)).toEqual({ main: "", signed: false });
  });
  it("renders paragraphs and escapes markup", () => {
    const html = textToHtml("a < b\nsecond line\n\nnext");
    expect(html).toContain("a &lt; b<br>second line");
    expect(html.match(/<p /g)).toHaveLength(2);
  });
});
