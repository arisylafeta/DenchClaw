/** Server-only cutover flag. Unknown values deliberately preserve the REST transport. */
export function hermesChatTransport(): "gateway" | "sse" {
  return process.env.HERMES_CHAT_TRANSPORT === "gateway" ? "gateway" : "sse";
}
