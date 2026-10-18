import type { ToolSegment } from "@/lib/hermes-chat/reducer";
import { asRecord } from "@/lib/hermes-chat/events";
import { toolCategory } from "@/lib/hermes-chat/run-summary";

export type ResultPreview =
  | { kind: "code"; lines: string[]; note?: string }
  | { kind: "text"; text: string; note?: string }
  | { kind: "list"; items: { title: string; sub?: string; href?: string }[]; note?: string }
  | { kind: "table"; columns: string[]; rows: string[][]; note?: string }
  | { kind: "diff"; diff: string; note?: string };

const MAX_LINES = 14;
const MAX_ITEMS = 8;
const cell = (value: unknown, max = 60) => { const text = typeof value === "string" ? value : value === null || value === undefined ? "" : typeof value === "object" ? JSON.stringify(value) : String(value); return text.length > max ? `${text.slice(0, max - 1)}…` : text; };
const clip = (line: string, max = 200) => line.length > max ? `${line.slice(0, max - 1)}…` : line;
const host = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; } };
const safeHref = (url: unknown) => typeof url === "string" && /^https?:\/\//i.test(url) ? url : undefined;

/** Results arrive as parsed JSON, a JSON string, or a string wrapped in an untrusted-content envelope. */
export function normalizeResult(result: unknown): unknown {
  if (typeof result !== "string") return result;
  const unwrapped = result.replace(/^<untrusted_tool_result[^>]*>[\s\S]*?\n\n(?=[{\[])/, "").replace(/<\/untrusted_tool_result>\s*$/, "").trim();
  if (/^[{\[]/.test(unwrapped)) { try { return JSON.parse(unwrapped); } catch { /* Plain text that merely starts with a bracket. */ } }
  return unwrapped;
}
function lines(text: string, tail = false): ResultPreview | null {
  const all = text.replace(/\s+$/, "").split("\n");
  if (all.length === 1 && !all[0]) return null;
  const shown = tail ? all.slice(-MAX_LINES) : all.slice(0, MAX_LINES);
  return { kind: "code", lines: shown.map(line => clip(line)), note: all.length > MAX_LINES ? `${tail ? "Last" : "First"} ${MAX_LINES} of ${all.length} lines` : all.length > 1 ? `${all.length} lines` : undefined };
}
function table(rows: Record<string, unknown>[]): ResultPreview {
  const columns = [...new Set(rows.slice(0, 20).flatMap(row => Object.keys(row)))].slice(0, 5);
  return { kind: "table", columns, rows: rows.slice(0, 6).map(row => columns.map(column => cell(row[column]))), note: rows.length > 6 ? `First 6 of ${rows.length} rows` : `${rows.length} ${rows.length === 1 ? "row" : "rows"}` };
}
function generic(value: unknown): ResultPreview | null {
  if (Array.isArray(value) && value.length && value.every(item => item && typeof item === "object" && !Array.isArray(item))) return table(value as Record<string, unknown>[]);
  if (typeof value === "string") return lines(value);
  if (value === undefined || value === null) return null;
  return lines(JSON.stringify(value, null, 2));
}

/** A short, safe preview of what a tool returned. Never includes tool arguments. */
export function buildPreview(tool: Pick<ToolSegment, "name" | "result" | "inline_diff" | "status" | "summary">): ResultPreview | null {
  if (tool.status === "running") return null;
  if (tool.inline_diff) return { kind: "diff", diff: tool.inline_diff };
  const value = normalizeResult(tool.result);
  const record = asRecord(value);
  const category = toolCategory(tool.name);
  if (typeof record.diff === "string" && record.diff) return { kind: "diff", diff: record.diff };
  if (category === "run" || tool.name === "execute_code") {
    const output = typeof record.output === "string" ? record.output : typeof record.stdout === "string" ? record.stdout : typeof value === "string" ? value : "";
    const preview = output ? lines(output, true) : null;
    const exit = record.exit_code;
    if (preview && preview.kind === "code" && exit !== undefined && exit !== 0 && exit !== null) preview.note = `Exit code ${String(exit)}${preview.note ? ` · ${preview.note}` : ""}`;
    return preview;
  }
  if (tool.name === "read_file" || tool.name === "read") {
    const content = typeof record.content === "string" ? record.content : typeof value === "string" ? value : "";
    return content ? lines(content) : null;
  }
  if (tool.name === "write_file") {
    const files = Array.isArray(record.files_modified) ? record.files_modified.map(String) : [];
    if (files.length) return { kind: "list", items: files.map(file => ({ title: file.split("/").pop() ?? file, sub: file })), note: typeof record.bytes_written === "number" ? `${record.bytes_written} bytes written` : undefined };
  }
  if (tool.name === "search_files" || tool.name === "glob" || tool.name === "grep") {
    const files = Array.isArray(record.files) ? record.files.map(String) : [];
    const matches = Array.isArray(record.matches) ? record.matches.map(asRecord) : [];
    const total = typeof record.total_count === "number" ? record.total_count : files.length || matches.length;
    if (matches.length) return { kind: "list", items: matches.slice(0, MAX_ITEMS).map(match => ({ title: `${cell(match.path ?? match.file, 80).split("/").pop()}${match.line ? `:${String(match.line)}` : ""}`, sub: cell(match.content ?? match.text, 110) })), note: total > MAX_ITEMS ? `First ${MAX_ITEMS} of ${total}` : `${total} matches` };
    if (files.length) return { kind: "list", items: files.slice(0, MAX_ITEMS).map(file => ({ title: file.split("/").pop() ?? file, sub: file })), note: total > MAX_ITEMS ? `First ${MAX_ITEMS} of ${total}` : `${total} ${total === 1 ? "file" : "files"}` };
    return { kind: "text", text: "No matches" };
  }
  if (tool.name === "web_search") {
    const web = Array.isArray(asRecord(record.data).web) ? (asRecord(record.data).web as unknown[]).map(asRecord) : Array.isArray(record.results) ? (record.results as unknown[]).map(asRecord) : [];
    if (web.length) return { kind: "list", items: web.slice(0, 6).map(item => ({ title: cell(item.title ?? item.url, 90), sub: [host(String(item.url ?? "")), cell(item.description ?? item.snippet, 110)].filter(Boolean).join(" · "), href: safeHref(item.url) })), note: `${web.length} results` };
  }
  if (tool.name === "web_extract" || tool.name === "web_fetch") {
    const pages = Array.isArray(record.results) ? (record.results as unknown[]).map(asRecord) : [];
    if (pages.length) return { kind: "list", items: pages.slice(0, 5).map(page => ({ title: cell(page.title ?? page.url, 90), sub: [host(String(page.url ?? "")), cell(page.content ?? page.text, 120)].filter(Boolean).join(" · "), href: safeHref(page.url) })), note: `${pages.length} ${pages.length === 1 ? "page" : "pages"}` };
  }
  if (tool.name === "skill_view" && typeof record.name === "string") return { kind: "text", text: `${record.name}${typeof record.description === "string" ? `\n${cell(record.description, 240)}` : ""}` };
  if (tool.name === "delegate_task" && (typeof record.note === "string" || typeof record.status === "string")) return { kind: "text", text: [record.status && `Status: ${String(record.status)}`, record.note && cell(record.note, 240)].filter(Boolean).join("\n") };
  if (tool.name === "tool_call" || tool.name === "tool_describe" || tool.name === "tool_search") return generic(value);
  if (typeof record.error === "string" && record.error) return { kind: "text", text: cell(record.error, 400) };
  const fallback = generic(value);
  if (fallback) return fallback;
  return tool.summary ? { kind: "text", text: tool.summary } : null;
}
/** Full text for the copy button. */
export function previewCopyText(tool: Pick<ToolSegment, "result" | "inline_diff">): string {
  if (tool.inline_diff) return tool.inline_diff;
  const value = normalizeResult(tool.result);
  return typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? "";
}
