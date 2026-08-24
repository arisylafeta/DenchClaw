import { NextResponse } from "next/server";
import { getTerminalPort } from "@/lib/terminal-server";

export const dynamic = "force-dynamic";

export function GET() {
  const port = getTerminalPort();
  const proxy = process.env.DENCHCLAW_DAEMONLESS === "1";
  return NextResponse.json({ port, proxy });
}
