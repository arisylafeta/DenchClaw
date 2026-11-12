import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const run = promisify(execFile);
const CHROME = process.env.DENCH_PDF_CHROME || "/usr/bin/google-chrome";

const STYLE = `
@page { size: A4; margin: 14mm 15mm; }
body { font: 10pt/1.38 Helvetica, Arial, sans-serif; color: #111; margin: 0; }
h1 { font-size: 20pt; margin: 0 0 2pt; text-align: center; letter-spacing: .2pt; }
h1 + p { text-align: center; margin: 0 0 3pt; }
h2 { font-size: 10.5pt; text-transform: uppercase; letter-spacing: .8pt; border-bottom: 1px solid #111; margin: 11pt 0 5pt; padding-bottom: 1.5pt; }
h3 { font-size: 10.5pt; margin: 7pt 0 1pt; }
p { margin: 2pt 0; }
em { color: #444; }
ul { margin: 2pt 0 2pt 0; padding-left: 14pt; }
li { margin: 1.5pt 0; }
code { font: inherit; background: #ffe9a8; }
a { color: inherit; text-decoration: none; }
`;

/** Markdown to a standalone, print-styled HTML page. */
export function renderDocumentHtml(markdown: string, title: string): string {
  const body = renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, markdown));
  const safeTitle = title.replace(/[<>&"]/g, "");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${safeTitle}</title><style>${STYLE}</style></head><body>${body}</body></html>`;
}

/** Print a markdown document to PDF with headless Chrome. */
export async function renderDocumentPdf(markdown: string, title: string): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "dench-doc-pdf-"));
  try {
    const html = join(dir, "doc.html");
    const pdf = join(dir, "doc.pdf");
    await writeFile(html, renderDocumentHtml(markdown, title), "utf-8");
    await run(CHROME, ["--headless=new", "--no-sandbox", "--disable-gpu", "--no-pdf-header-footer", `--user-data-dir=${join(dir, "profile")}`, `--print-to-pdf=${pdf}`, `file://${html}`], { timeout: 45_000 });
    return await readFile(pdf);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
