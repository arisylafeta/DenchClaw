// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { prepareEmail } from "./sanitize-email";
import { MessageBody } from "./message-body";

const parsed = (html: string, images = false, quotes = false) => new DOMParser().parseFromString(prepareEmail(html, images, quotes).srcdoc, "text/html");
describe("email HTML safety", () => {
  it.each([
    '<script>alert(1)</script>', '<img src="https://example.test/pixel" onerror="alert(1)">',
    '<a href="javascript:alert(1)">bad</a>', '<a href="java&#10;script:alert(1)">bad</a>',
    '<svg onload="alert(1)"><a href="javascript:alert(1)">bad</a></svg>',
    '<div style="background:url(javascript:alert(1));color:red">safe</div>',
    '<a href="  &#106;avascript:alert(1)">bad</a>',
    '<math><mtext><table><mglyph><style><!--</style><img title="--><img src=x onerror=alert(1)>">',
    '<svg><foreignObject><div><img src=x onerror=alert(1)></div></foreignObject></svg>',
    '<svg><style><a id="</style><img src=x onerror=alert(1)>">bad</a></style></svg>',
    '<noscript><p title="</noscript><img src=x onerror=alert(1)>">bad</p></noscript>',
    '<math><annotation-xml encoding="text/html"><svg onload=alert(1)></svg></annotation-xml></math>',
    '<div style="width:expression(alert(1))">safe</div>',
    '<style>p{background:u\\72l(https://example.test/pixel)}</style>',
    '<meta http-equiv="refresh" content="0;url=https://example.test">',
    '<iframe srcdoc="<script>alert(1)</script>"></iframe><object data="evil"></object><embed src="evil">',
    '<form action="https://example.test"><input name="secret"></form>',
    '<base href="https://example.test"><link rel="stylesheet" href="https://example.test/evil.css">',
  ])("neutralises %s", (attack) => {
    const doc = parsed(`<p>Safe content</p>${attack}`);
    expect(doc.body.textContent).toContain("Safe content");
    expect(doc.querySelector("script,svg,iframe,object,embed,form,input,base,link,meta[http-equiv=refresh]")).toBeNull();
    for (const element of Array.from(doc.querySelectorAll("*"))) for (const attr of Array.from(element.attributes)) {
      expect(attr.name).not.toMatch(/^on/i);
      expect(attr.value).not.toMatch(/javascript:|expression\s*\(/i);
    }
    expect(doc.querySelector("style")?.textContent).not.toContain("url(");
  });
  it("preserves tracked links and makes every anchor a safe new-tab link", () => {
    const link = parsed('<a href="https://links.rebattery.io/track/123">View packs</a>').querySelector("a")!;
    expect(link.getAttribute("href")).toBe("https://links.rebattery.io/track/123");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer nofollow");
  });
  it("blocks remote requests until consent and silently removes cid images", () => {
    const html = '<img src="https://example.test/banner.png"><img src="cid:attachment"><img src="data:image/png;base64,AAAA">';
    expect(prepareEmail(html).hasRemoteImages).toBe(true);
    expect(parsed(html).querySelectorAll("img[src]")).toHaveLength(1);
    expect(parsed(html, true).querySelectorAll("img[src]")).toHaveLength(2);
    expect(prepareEmail(html).srcdoc).not.toContain("cid:");
    expect(prepareEmail(html).srcdoc).toContain("img-src data:;");
    expect(prepareEmail(html, true).srcdoc).toContain("img-src data: https:;");
  });
  it.each(['class="gmail_quote"','class="gmail_extra"','class="gmail_signature"','id="divRplyFwdMsg"','id="appendonsend"'])("folds %s before serialization", (attr) => {
    const html = `<p>Current</p><div ${attr}>Earlier message</div>`;
    expect(prepareEmail(html).hasQuoted).toBe(true);
    expect(parsed(html).body.textContent).toBe("Current");
    expect(parsed(html, false, true).body.textContent).toContain("Earlier message");
  });
  it("folds cite blockquotes and Outlook history following its header", () => {
    expect(parsed('<p>Current</p><blockquote type="cite">History</blockquote>').body.textContent).toBe("Current");
    expect(parsed('<p>Current</p><div id="divRplyFwdMsg">Header</div><p>History</p>').body.textContent).toBe("Current");
  });
  it("prefers HTML, enables remote images only for that message and never enables scripts", () => {
    const { rerender } = render(<MessageBody body="Text alternative" html={'<p>HTML version</p><img src="https://example.test/image.png">'} preview={null} />);
    const frame = screen.getByTitle("Email body");
    expect(frame.getAttribute("srcdoc")).toContain("HTML version");
    expect(screen.queryByText("Text alternative")).toBeNull();
    expect(frame.getAttribute("sandbox")).not.toContain("allow-scripts");
    fireEvent.click(screen.getByRole("button", { name: "Load images" }));
    expect(frame.getAttribute("srcdoc")).toContain('src="https://example.test/image.png"');
    rerender(<MessageBody body="Next" html={'<p>Next</p><img src="https://example.test/next.png">'} preview={null} />);
    expect(screen.getByRole("button", { name: "Load images" })).toBeInTheDocument();
    expect(screen.getByTitle("Email body").getAttribute("srcdoc")).not.toContain('src="https://example.test/next.png"');
  });
  it("renders plain text literally when HTML is absent", () => {
    render(<MessageBody body="Use <p> in the template" html={null} preview="preview" />);
    expect(screen.getByText("Use <p> in the template")).toBeInTheDocument();
    expect(screen.queryByTitle("Email body")).toBeNull();
  });
});
