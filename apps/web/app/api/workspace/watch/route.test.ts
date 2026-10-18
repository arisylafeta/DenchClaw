import { expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  root: "/synthetic/workspace",
  handlers: new Map<string, (...args: string[]) => void>(),
  close: vi.fn(async () => {}),
}));
vi.mock("@/lib/workspace", () => ({ resolveWorkspaceRoot: () => fake.root }));
vi.mock("chokidar", () => ({ watch: () => ({
  on: (event: string, handler: (...args: string[]) => void) => fake.handlers.set(event, handler),
  once: vi.fn(), close: fake.close,
}) }));
import { GET } from "./route";

it("stops initialization if the connection aborts before the watcher is ready", async () => {
  fake.close.mockClear();
  const abort = new AbortController();
  const pending = GET(new Request("http://synthetic.test/api/workspace/watch", { signal: abort.signal }));
  abort.abort();
  const response = await pending;
  await vi.waitFor(() => expect(fake.close).toHaveBeenCalled());
  await response.body!.cancel();
});

it("emits both paths in a rapid batch with resolved root and tears down on cancel", async () => {
  const response = await GET(new Request("http://synthetic.test/api/workspace/watch"));
  const reader = response.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain("event: connected");
  // Wait for the asynchronous chokidar import to install its handler.
  await vi.waitFor(() => expect(fake.handlers.has("all")).toBe(true));
  fake.handlers.get("all")!("change", `${fake.root}/a.md`);
  fake.handlers.get("all")!("change", `${fake.root}/b.md`);
  for (const path of ["a.md", "b.md"]) {
    const chunk = new TextDecoder().decode((await reader.read()).value);
    expect(chunk).toContain(JSON.stringify({ type: "change", path, root: fake.root }));
  }
  await reader.cancel();
  expect(fake.close).toHaveBeenCalled();
});
