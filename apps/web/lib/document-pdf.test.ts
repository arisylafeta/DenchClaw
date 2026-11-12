import { describe, expect, it } from "vitest";
import { renderDocumentHtml } from "./document-pdf";

describe("renderDocumentHtml", () => {
  it("renders headings, lists and escapes the title", () => {
    const html = renderDocumentHtml("# Name\n\n## Skills\n\n- **TypeScript**\n", 'a"<b>');
    expect(html).toContain("<h1>Name</h1>");
    expect(html).toContain("<h2>Skills</h2>");
    expect(html).toContain("<strong>TypeScript</strong>");
    expect(html).toContain("<title>ab</title>");
  });
  it("does not emit raw html from the markdown", () => {
    expect(renderDocumentHtml("<script>alert(1)</script>", "t")).not.toContain("<script>alert");
  });
});
