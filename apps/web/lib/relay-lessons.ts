import "server-only";
import { appendFile, readFile, stat } from "node:fs/promises";

/**
 * Alex's email-writing lessons: one memory file every Claude session loads, and every Relay draft is written with
 * (the desk's brief and the one-shot draft). The one place to edit them; the desk adds to it when Alex says so.
 */
export const LESSONS_FILE = process.env.RELAY_LESSONS_FILE || "/root/.claude-alex/projects/-root--hermes/memory/email-writing-lessons.md";
const ADDED_HEADING = "## Added from Relay chats";

let cached: { stamp: string; text: string } | null = null;

/** The lessons, without the memory file's frontmatter. Empty when the file is missing: drafting goes on without them. */
export async function readLessons(): Promise<string> {
  try {
    const info = await stat(LESSONS_FILE);
    const stamp = `${info.mtimeMs}:${info.size}`;
    if (cached?.stamp === stamp) return cached.text;
    const text = lessonsBody(await readFile(LESSONS_FILE, "utf8"));
    cached = { stamp, text };
    return text;
  } catch {
    return "";
  }
}

/** Adds one lesson under "Added from Relay chats", dated, unless the file already says it. */
export async function addLesson(lesson: string, now = new Date()): Promise<"added" | "known"> {
  const line = lesson.replace(/\s+/g, " ").trim().replace(/^[-*]\s*/, "");
  const current = await readFile(LESSONS_FILE, "utf8").catch(() => "");
  if (current.toLowerCase().includes(line.toLowerCase())) return "known";
  const date = now.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Europe/London" });
  await appendFile(LESSONS_FILE, `${current.includes(ADDED_HEADING) ? "" : `\n${ADDED_HEADING}\n`}- ${line} (${date})\n`);
  cached = null;
  return "added";
}

/** The body of a memory file: everything after its frontmatter. */
export const lessonsBody = (file: string) => file.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
