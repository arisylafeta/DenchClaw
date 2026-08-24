import { NextResponse } from "next/server";
import { getTerminalPort } from "@/lib/terminal-server";
import { issueTerminalAccessToken } from "@/lib/terminal-access";

export const dynamic = "force-dynamic";

export function GET() {
  const port = getTerminalPort();
  const proxy = process.env.DENCHCLAW_DAEMONLESS === "1";
  const accessToken = issueTerminalAccessToken();
  return NextResponse.json({ port, proxy, accessToken });
}
