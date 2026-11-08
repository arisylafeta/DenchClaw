// Creates the offer email as a draft through the mail CLI, the same way Relay does: threading, the identity
// signature and the CLI's content checks all apply, and nothing is sent.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { textToHtml } from "../mail-draft-actions";

const run = promisify(execFile);
const CLI = "/usr/local/bin/rebattery-mail";

export class OfferDraftError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "OfferDraftError";
  }
}

/** Stores one unsent draft from Alex's identity and returns its id. Never sends. */
export async function createOfferEmailDraft(input: { to: string[]; subject: string; body: string }): Promise<string> {
  const args = [
    "draft", "--identity", "alex", "--transport", "gmail", "--purpose", "personal",
    "--to", input.to.join(","), `--subject=${input.subject}`, `--body=${input.body}`, `--html=${textToHtml(input.body)}`,
    "--apply",
  ];
  try {
    const { stdout } = await run(CLI, args, { timeout: 90_000, maxBuffer: 8 << 20 });
    const parsed = JSON.parse(stdout) as { message?: { id?: string }; id?: string };
    const id = parsed.message?.id ?? parsed.id;
    if (!id) {
      throw new OfferDraftError(502, "The mail command did not return a draft.");
    }
    return id;
  } catch (error) {
    if (error instanceof OfferDraftError) {
      throw error;
    }
    const out = error as { stdout?: string; stderr?: string };
    try {
      const parsed = JSON.parse((out.stdout ?? "").trim()) as { refused?: string; message?: string };
      if (parsed.refused) {
        throw new OfferDraftError(409, `${parsed.refused}${parsed.message && parsed.message !== parsed.refused ? `: ${parsed.message}` : ""}`);
      }
    } catch (inner) {
      if (inner instanceof OfferDraftError) {
        throw inner;
      }
    }
    throw new OfferDraftError(502, (out.stderr ?? "").trim().split("\n")[0] || "Could not create the draft.");
  }
}
