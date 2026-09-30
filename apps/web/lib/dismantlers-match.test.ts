import { describe, expect, it } from "vitest";
import { bareDomain, matchAccounts, type AccountForMatch, type DismantlerForMatch } from "./dismantlers-match";

const accounts: AccountForMatch[] = [
  { id: "a1", name: "Yard One Ltd", emails: ["sam@yardone.co.uk"] },
  { id: "a2", name: "Parts Two", emails: ["jo@gmail.com", "ops@partstwo.nl"] },
  { id: "a3", name: "Twin A", emails: ["a@twin.com"] },
  { id: "a4", name: "Twin B", emails: ["b@twin.com"] },
];
const D = (o: Partial<DismantlerForMatch>): DismantlerForMatch => ({ id: "d", platform_account_id: null, emails: [], domain: null, ...o });

describe("matching dismantlers to ReBattery accounts", () => {
  it("links by hand, then by a shared email, then by the company's own domain", () => {
    const matches = matchAccounts([
      D({ id: "hand", platform_account_id: "a2", emails: ["sam@yardone.co.uk"] }),
      D({ id: "email", emails: ["SAM@yardone.co.uk"] }),
      D({ id: "domain", domain: "https://www.partstwo.nl/contact" }),
      D({ id: "none", platform_account_id: "none", emails: ["ops@partstwo.nl"] }),
    ], accounts);
    expect(Object.fromEntries([...matches].map(([id, m]) => [id, [m.account.id, m.matched_by]]))).toEqual({
      hand: ["a2", "linked"],
      // a1 is also claimed by nobody else automatically, so the email match stands.
      email: ["a1", "email"],
      domain: ["a2", "domain"],
    });
  });

  it("never guesses: shared mailboxes, a domain two accounts use, or one account two dismantlers claim", () => {
    const matches = matchAccounts([
      D({ id: "gmail", domain: "gmail.com" }),
      D({ id: "twins", domain: "twin.com" }),
      D({ id: "first", emails: ["ops@partstwo.nl"] }),
      D({ id: "second", domain: "partstwo.nl" }),
      D({ id: "gone", platform_account_id: "deleted-account" }),
    ], accounts);
    expect([...matches.keys()]).toEqual([]);
  });

  it("reads a domain from a website or a bare name", () => {
    expect(bareDomain("https://www.Example.co.uk/parts?x=1")).toBe("example.co.uk");
    expect(bareDomain("example.nl")).toBe("example.nl");
    expect(bareDomain("not a site")).toBeNull();
    expect(bareDomain(null)).toBeNull();
  });
});
