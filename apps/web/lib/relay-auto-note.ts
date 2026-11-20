/** The note Relay drafts from when Alex hasn't said anything yet: ahead of time for the top of "Waiting on you", and when
 * he opens an email with no reply. The page shows it as Relay's own work, never as his words. */
export const AUTO_NOTE = "Relay's first draft, before Alex said anything. Answer their newest email: what they asked, using only what the thread, the deal and the background give. If they want to buy, offer the stock that fits best. Ask for anything we still need from them. Keep it short.";

export const isAutoNote = (note: string | null | undefined) => (note ?? "").trim() === AUTO_NOTE;
