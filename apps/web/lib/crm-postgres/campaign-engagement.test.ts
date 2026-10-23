import { describe, expect, it, vi } from "vitest";
import { countOpenSessions, isProxyOrScanner, rankCampaignEngagement, readCampaignEngagement, type EngagementEvent, type EngagementMessage } from "./campaign-engagement";

const queryPg = vi.hoisted(() => vi.fn());
vi.mock("../postgres", () => ({ queryPg }));
const event = (type: string, seconds: number, detail = {}): EngagementEvent => ({ type, occurred_at: new Date(Date.UTC(2026, 9, 8) + seconds * 1000).toISOString(), detail });
const click = (seconds: number, link: string) => event("clicked", seconds, { Details: { Link: link } });
const message = (events: EngagementEvent[], overrides: Partial<EngagementMessage> = {}): EngagementMessage => ({
  id: "m1", person_id: "p1", person_name: "Reader", company_name: "Company", recipient_email: "reader@example.com",
  delivered_at: null, replied: false, links: ["a", "b", "c", "d", "e", "f"], events, ...overrides,
});

describe("campaign engagement observations", () => {
  it("uses a strict gap of more than ten minutes, not fixed buckets", () => {
    expect(countOpenSessions([])).toBe(0);
    expect(countOpenSessions([600000, 0, 1200000, 1800001])).toBe(2);
  });

  it("flags explicit proxies and scanners, not normal Apple browsers", () => {
    for (const ua of ["GoogleImageProxy via ggpht.com", "Apple Mail Privacy Protection", "Proofpoint scanner", "Barracuda"]) {
      expect(isProxyOrScanner({ Details: { Summary: ua } })).toBe(true);
    }
    expect(isProxyOrScanner({ UserAgent: "iPhone AppleWebKit/605.1.15 Mobile/15E148" })).toBe(false);
    expect(isProxyOrScanner({})).toBe(false);
  });

  it("keeps one-open/five-link scanners out of human clicks even with six tracked destinations", () => {
    const rows = rankCampaignEngagement([
      message([event("opened", 20), ...["a", "b", "c", "d", "e"].map((link) => click(30, link))]),
      message([event("opened", 20), click(90, "a")], { id: "m2", person_id: "p2" }),
    ]);
    expect(rows.map((row) => row.person_id)).toEqual(["p2", "p1"]);
    expect(rows[1]).toMatchObject({ total_opens: 1, flagged_opens: 1, flagged_clicks: 5, human_links_clicked: 0, likely_bot: true });
  });

  it("flags near-delivery clicks and preserves later distinct human clicks and returns", () => {
    const [row] = rankCampaignEngagement([message([
      event("delivered", 0), event("opened", 30), event("opened", 630), event("opened", 1231),
      click(5, "a"), click(6, "b"), click(90, "b"), click(120, "b"), event("replied", 1300),
    ])]);
    expect(row).toMatchObject({ total_opens: 3, return_sessions: 1, human_links_clicked: 1, flagged_clicks: 1, replied: true, likely_bot: false });
    expect(row.last_opened).toBe(event("opened", 1231).occurred_at);
  });

  it("detects all tracked links in a burst and does not flag spaced legitimate clicks", () => {
    const [scanner] = rankCampaignEngagement([message([click(30, "a"), click(35, "b")], { links: ["a", "b"] })]);
    expect(scanner).toMatchObject({ flagged_clicks: 2, likely_bot: true });
    const [human] = rankCampaignEngagement([message([click(30, "a"), click(36, "b"), click(42, "c")])]);
    expect(human).toMatchObject({ human_links_clicked: 3, flagged_clicks: 0, likely_bot: false });
  });

  it("aggregates multiple campaign messages per person without multiplying events", () => {
    const [row] = rankCampaignEngagement([
      message([event("opened", 0), click(100, "a")]),
      message([event("opened", 601), click(200, "a")], { id: "m2", replied: true }),
    ]);
    expect(row).toMatchObject({ total_opens: 2, return_sessions: 1, human_links_clicked: 1, replied: true });
  });

  it("retains flagged proxy sessions in observed returns and labels all-flagged activity", () => {
    const proxy = { UserAgent: "GoogleImageProxy" };
    const [row] = rankCampaignEngagement([message([event("opened", 0, proxy), event("opened", 601, proxy)])]);
    expect(row).toMatchObject({ total_opens: 2, flagged_opens: 2, return_sessions: 1, likely_bot: true });
    expect(rankCampaignEngagement([message([])])[0].likely_bot).toBe(false);
  });

  it("drops only matched legacy snapshots, retaining genuine repeats and unmatched snapshots", () => {
    const proxy = { UserAgent: "GoogleImageProxy" };
    const legacy = { ...event("opened", 0), provider_event_id: "legacy:m1:opened" };
    const real = { ...event("opened", 0, proxy), provider_event_id: "real-1" };
    const [matched] = rankCampaignEngagement([message([legacy, real])]);
    expect(matched).toMatchObject({ total_opens: 1, flagged_opens: 1, likely_bot: true });
    const [genuine] = rankCampaignEngagement([message([real, { ...real, provider_event_id: "real-2" }, { ...legacy, occurred_at: event("opened", 601).occurred_at }])]);
    expect(genuine).toMatchObject({ total_opens: 3, flagged_opens: 2, return_sessions: 1, likely_bot: false });
  });

  it("reads only the requested outbound campaign through a parameterised ledger query", async () => {
    queryPg.mockResolvedValueOnce([message([event("opened", 0)])]);
    expect(await readCampaignEngagement("campaign-1")).toHaveLength(1);
    expect(queryPg).toHaveBeenLastCalledWith(expect.stringContaining("m.campaign_id = $1 and m.direction = 'outbound'"), ["campaign-1"]);
  });
});
