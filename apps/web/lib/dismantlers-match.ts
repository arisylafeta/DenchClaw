// Matches dismantlers to ReBattery supplier accounts. Pure, so it is easy to test.

export type AccountForMatch = { id: string; name: string; emails: string[] };
export type DismantlerForMatch = {
  id: string;
  /** Set by hand: an account id, "none", or null to match automatically. */
  platform_account_id: string | null;
  /** Emails of the company's people in the CRM. */
  emails: string[];
  /** The company's domain or website. */
  domain: string | null;
};
export type AccountMatch = { account: AccountForMatch; matched_by: "linked" | "email" | "domain" };

// Personal mailboxes say nothing about which company someone works for.
const SHARED_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "hotmail.com", "hotmail.co.uk", "outlook.com", "live.com", "live.co.uk",
  "msn.com", "yahoo.com", "yahoo.co.uk", "icloud.com", "me.com", "mac.com", "aol.com", "btinternet.com",
  "sky.com", "virginmedia.com", "talktalk.net", "gmx.com", "gmx.de", "web.de", "ziggo.nl", "kpnmail.nl",
  "home.nl", "planet.nl", "hetnet.nl", "telenet.be", "skynet.be", "proton.me", "protonmail.com",
  "rebattery.io",
]);

/** "https://www.example.co.uk/parts" or "Example.co.uk" to "example.co.uk". */
export function bareDomain(value: string | null | undefined): string | null {
  const text = (value ?? "").trim().toLowerCase();
  if (!text) return null;
  const host = text.replace(/^[a-z]+:\/\//, "").split(/[/?#]/)[0].replace(/^www\./, "");
  return host.includes(".") ? host : null;
}

const emailDomain = (email: string) => email.split("@")[1]?.toLowerCase() ?? "";

/**
 * Each dismantler's account: the one linked by hand, else the one account sharing a person's
 * email, else the one account whose members use the company's own domain. Ambiguous matches are
 * left unmatched, and so is an account two dismantlers would claim automatically.
 */
export function matchAccounts(dismantlers: DismantlerForMatch[], accounts: AccountForMatch[]): Map<string, AccountMatch> {
  const byId = new Map(accounts.map((account) => [account.id, account]));
  const byEmail = new Map<string, Set<string>>();
  const byDomain = new Map<string, Set<string>>();
  for (const account of accounts) {
    for (const raw of account.emails) {
      const email = raw.trim().toLowerCase();
      if (!email.includes("@")) continue;
      if (!byEmail.has(email)) byEmail.set(email, new Set());
      byEmail.get(email)!.add(account.id);
      const domain = emailDomain(email);
      if (SHARED_DOMAINS.has(domain)) continue;
      if (!byDomain.has(domain)) byDomain.set(domain, new Set());
      byDomain.get(domain)!.add(account.id);
    }
  }

  const matches = new Map<string, AccountMatch>();
  const automatic = new Map<string, string[]>();
  for (const d of dismantlers) {
    if (d.platform_account_id === "none") continue;
    if (d.platform_account_id) {
      const account = byId.get(d.platform_account_id);
      if (account) matches.set(d.id, { account, matched_by: "linked" });
      continue;
    }
    const viaEmail = new Set(d.emails.flatMap((email) => [...(byEmail.get(email.trim().toLowerCase()) ?? [])]));
    const domain = bareDomain(d.domain);
    const viaDomain = domain && !SHARED_DOMAINS.has(domain) ? byDomain.get(domain) ?? new Set<string>() : new Set<string>();
    const [found, how] = viaEmail.size ? [viaEmail, "email" as const] : [viaDomain, "domain" as const];
    if (found.size !== 1) continue;
    const id = [...found][0];
    matches.set(d.id, { account: byId.get(id)!, matched_by: how });
    automatic.set(id, [...(automatic.get(id) ?? []), d.id]);
  }
  // One account, two dismantlers: a guess would be wrong half the time. Leave both for a person.
  for (const claimants of automatic.values()) if (claimants.length > 1) for (const id of claimants) matches.delete(id);
  return matches;
}
