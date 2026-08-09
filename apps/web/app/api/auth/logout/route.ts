import { NextResponse } from "next/server";
import { revokeSession, SESSION_COOKIE } from "@/lib/auth";
export async function POST() {
  await revokeSession();
  const r = NextResponse.json({ ok: true });
  r.cookies.set({ name: SESSION_COOKIE, value: "", path: "/", maxAge: 0 });
  return r;
}
