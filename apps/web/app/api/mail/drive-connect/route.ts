import { currentUser } from "@/lib/auth";
import { DriveError, driveConnectFinish, driveConnectUrl } from "@/lib/google-drive";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const failed = (error: unknown) => error instanceof DriveError
  ? Response.json({ error: error.code, message: error.message }, { status: error.code === "bad_redirect" || error.code === "bad_account" ? 400 : 502 })
  : Response.json({ error: "drive_failed", message: "Something went wrong. Try again." }, { status: 500 });

/** Connect Google Drive to the signed-in user's existing Google login. POST {} returns Google's consent URL;
 * POST { redirect_url } finishes with the address Google opened afterwards. The one-time code never leaves this route. */
export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { redirect_url?: unknown } | null;
  try {
    if (typeof body?.redirect_url === "string") {
      await driveConnectFinish(user.email, body.redirect_url);
      return Response.json({ connected: true });
    }
    return Response.json({ url: await driveConnectUrl(user.email) });
  } catch (error) {
    return failed(error);
  }
}
