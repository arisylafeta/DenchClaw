import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { discoverWorkspaces } from "@/lib/workspace";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const name = new URL(request.url).searchParams.get("name");
  if (!name || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(name)) {
    return new Response(null, { status: 404 });
  }
  // Only serve the fixed avatar file of a known Hermes profile, never a caller-supplied path.
  const workspace = process.env.DENCH_AGENT_BACKEND === "hermes"
    ? discoverWorkspaces().find((item) => item.name === name)
    : undefined;
  if (!workspace) return new Response(null, { status: 404 });

  try {
    const image = await readFile(join(workspace.stateDir, "assets", "avatar.png"));
    return new Response(new Uint8Array(image), {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "private, no-cache",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return new Response(null, { status: 404 });
  }
}
