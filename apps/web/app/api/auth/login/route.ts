import { NextResponse } from "next/server";
import { createSession, login, sessionCookie } from "@/lib/auth";

export async function POST(req: Request) {
  const origin = req.headers.get("origin");
  if (!origin || origin !== new URL(req.url).origin) {
    return NextResponse.json({ error: "CSRF check failed" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  if (
    typeof body !== "object" ||
    body === null ||
    typeof (body as Record<string, unknown>).email !== "string" ||
    typeof (body as Record<string, unknown>).password !== "string"
  ) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  try {
    const user = await login(
      (body as { email: string }).email,
      (body as { password: string }).password,
    );
    if (!user)
      return NextResponse.json(
        { error: "Invalid credentials" },
        { status: 401 },
      );
    const response = NextResponse.json({
      user: { email: user.email, displayName: user.displayName },
    });
    response.cookies.set(sessionCookie(await createSession(user.id)));
    return response;
  } catch (error) {
    console.error(
      "CRM login unavailable",
      error instanceof Error ? error.message : "unknown error",
    );
    return NextResponse.json(
      { error: "Login temporarily unavailable" },
      { status: 503 },
    );
  }
}
