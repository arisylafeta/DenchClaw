import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const dir = mkdtempSync(join(tmpdir(), "lessons-"));
const file = join(dir, "email-writing-lessons.md");
process.env.RELAY_LESSONS_FILE = file;
const { addLesson, lessonsBody, readLessons } = await import("./relay-lessons");

describe("relay lessons", () => {
  it("reads the file without its frontmatter, and nothing when it's missing", async () => {
    expect(await readLessons()).toBe("");
    writeFileSync(file, "---\nname: email-writing-lessons\n---\n\n## Voice\n- Plain, not effusive.\n");
    expect(await readLessons()).toBe("## Voice\n- Plain, not effusive.");
    expect(lessonsBody("no frontmatter")).toBe("no frontmatter");
  });
  it("adds a lesson once, dated, under its own heading", async () => {
    expect(await addLesson("Never mention our margin.", new Date("2026-11-22T12:00:00Z"))).toBe("added");
    expect(await addLesson("never mention our margin.")).toBe("known");
    const text = readFileSync(file, "utf8");
    expect(text).toContain("## Added from Relay chats\n- Never mention our margin. (22 Nov 2026)\n");
    expect(text.match(/Added from Relay chats/g)).toHaveLength(1);
    expect(await readLessons()).toContain("Never mention our margin.");
  });
});
