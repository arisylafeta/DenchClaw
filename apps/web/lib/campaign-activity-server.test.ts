import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CampaignActivityLedger } from "./crm-postgres/campaign-activity";
import type { CampaignPostHogEvent } from "./campaign-posthog";
import type * as CampaignPostHogModule from "./campaign-posthog";
import { aggregateCampaignActivity, getCampaignActivity, mapCampaignManifest } from "./campaign-activity-server";
import { CampaignPostHogError } from "./campaign-posthog";

const { readLedger, queryProvider } = vi.hoisted(() => ({ readLedger: vi.fn(), queryProvider: vi.fn() }));
vi.mock("./crm-postgres/campaign-activity", () => ({ readCampaignActivityLedger: readLedger }));
vi.mock("./campaign-posthog", async (original) => ({ ...await original<typeof CampaignPostHogModule>(), queryCampaignPostHog: queryProvider }));

const START = "2026-09-24T15:00:00.000Z";
const END = "2026-10-01T10:00:00.000Z";
const A = "a".repeat(32);
const B = "b".repeat(32);
const C = "c".repeat(32);
const REMOVED = "d".repeat(32);
const ledger: CampaignActivityLedger = { campaign_id: "customer-campaign", sent_at: START, links: [
  { person_id: "p1", recipient_email: "one@example.test", cta_key: "fpt", listing_id: "listing-fpt", label: "FPT", first_clicked_at: START },
  { person_id: "p1", recipient_email: "one@example.test", cta_key: "grid", listing_id: null, label: null, first_clicked_at: null },
  { person_id: "p2", recipient_email: "two@example.test", cta_key: "fpt", listing_id: "listing-fpt", label: "FPT", first_clicked_at: null },
  { person_id: "p1", recipient_email: "one@example.test", cta_key: "sourcing_form", listing_id: null, label: null, first_clicked_at: null },
] };
const manifest = { campaign_id: ledger.campaign_id, recipients: [
  { person_id: "p1", email: "one@example.test", links: { fpt: { link_id: A, url: "https://private.invalid/encrypted" }, grid: { link_id: B }, sourcing_form: {} } },
  { person_id: "p2", email: "two@example.test", links: { fpt: { link_id: C } } },
  { person_id: "removed", email: "removed@example.test", links: { fpt: { link_id: REMOVED } } },
] };
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "campaign-activity-"));
  vi.stubEnv("CRM_CAMPAIGN_MANIFEST_PATH", join(root, "send-manifest.json"));
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(END));
  readLedger.mockResolvedValue(ledger);
  queryProvider.mockResolvedValue({ events: [], observed_at: END });
});
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  await rm(root, { recursive: true, force: true });
});

function event(link: string, name: CampaignPostHogEvent["event"], count: number, session: string | null, kind: CampaignPostHogEvent["submission_kind"] = null): CampaignPostHogEvent {
  return { link_id: link, event: name, event_count: count, session_id: session, submission_kind: kind,
    first_at: "2026-09-25T10:00:00.000Z", last_at: "2026-09-25T11:00:00.000Z" };
}

describe("campaign attribution identities and aggregation", () => {
  it("unions repeated sessions globally and per destination while retaining repeated event counts", () => {
    const mapped = mapCampaignManifest(manifest, ledger);
    const result = aggregateCampaignActivity(mapped, [
      event(A, "campaign_link_clicked", 5, null), event(C, "campaign_link_clicked", 2, null),
      event(A, "campaign_page_viewed", 3, "shared-session"), event(B, "campaign_page_viewed", 2, "shared-session"),
      event(C, "campaign_page_viewed", 1, "shared-session"), event(A, "campaign_page_viewed", 1, "second-session"),
      event(A, "public_auction_submission_created", 2, "shared-session", "offer"),
    ]);
    expect(result.totals).toEqual({ redirect_events: 7, page_views: 7, sessions: 2, offer_events: 2,
      message_events: 0, buy_now_events: 0, redirect_recipients: 2, visited_recipients: 2,
      offer_recipients: 1, message_recipients: 0, buy_now_recipients: 0 });
    const fpt = result.destinations.find((item) => item.cta_key === "fpt")!;
    expect(fpt.sessions).toBe(2);
    expect(fpt.email_clicked_recipients).toBe(1);
    expect(fpt.people.find((person) => person.person_id === "p1")).toMatchObject({ sessions: 2, page_views: 4, offer_events: 2,
      first_browser_at: "2026-09-25T10:00:00.000Z", last_browser_at: "2026-09-25T11:00:00.000Z",
      last_offer_at: "2026-09-25T11:00:00.000Z", last_message_at: null, last_buy_now_at: null });
    expect(result.destinations.find((item) => item.cta_key === "grid")).toMatchObject({ listing_id: null, label: "All auctions", sessions: 1 });
    expect(result.destinations.some((item) => item.cta_key === "sourcing_form")).toBe(false);
    const serialized = JSON.stringify(result);
    for (const sensitive of [A, B, C, "shared-session", "one@example.test", "private.invalid"]) { expect(serialized).not.toContain(sensitive); }
  });

  it("counts repeated clicks and keeps the latest click isolated from views, submissions and other destinations", () => {
    const result = aggregateCampaignActivity(mapCampaignManifest(manifest, ledger), [
      { ...event(A, "campaign_link_clicked", 3, null), last_at: "2026-09-26T12:00:00.000Z" },
      event(A, "campaign_link_clicked", 2, null),
      { ...event(A, "campaign_page_viewed", 1, "browser"), last_at: "2026-09-27T12:00:00.000Z" },
      { ...event(A, "public_auction_submission_created", 1, null, "offer"), last_at: "2026-09-28T12:00:00.000Z" },
      { ...event(B, "campaign_link_clicked", 4, null), last_at: "2026-09-29T12:00:00.000Z" },
    ]);
    expect(result.totals.redirect_events).toBe(9);
    const fpt = result.destinations.find(destination => destination.cta_key === "fpt")!;
    expect(fpt.people.find(person => person.person_id === "p1")).toMatchObject({
      redirect_events: 5, last_clicked_at: "2026-09-26T12:00:00.000Z", last_browser_at: "2026-09-27T12:00:00.000Z",
    });
    expect(fpt.people.find(person => person.person_id === "p2")).toMatchObject({ redirect_events: 0, last_clicked_at: null });
    expect(result.destinations.find(destination => destination.cta_key === "grid")?.people[0]).toMatchObject({
      redirect_events: 4, last_clicked_at: "2026-09-29T12:00:00.000Z", last_browser_at: null,
    });
  });

  it("records a server submission without inventing a browser visit or browser session", () => {
    const result = aggregateCampaignActivity(mapCampaignManifest(manifest, ledger), [
      event(C, "public_auction_submission_created", 1, "server-session", "offer"),
    ]);
    expect(result.totals).toMatchObject({ offer_events: 1, offer_recipients: 1, page_views: 0, visited_recipients: 0, sessions: 0 });
    expect(result.destinations.find((destination) => destination.cta_key === "fpt")?.people.find((person) => person.person_id === "p2")).toMatchObject({
      offer_events: 1, page_views: 0, sessions: 0,
      first_browser_at: null, last_browser_at: null, last_offer_at: "2026-09-25T11:00:00.000Z", last_message_at: null, last_buy_now_at: null,
    });
  });

  it("keeps each submission kind's latest timestamp independent without creating browser activity", () => {
    const result = aggregateCampaignActivity(mapCampaignManifest(manifest, ledger), [
      { ...event(A, "public_auction_submission_created", 2, "server-session", "offer"), last_at: "2026-09-26T12:00:00.000Z" },
      { ...event(A, "public_auction_submission_created", 1, "server-session", "message"), last_at: "2026-09-27T12:00:00.000Z" },
      { ...event(A, "public_auction_submission_created", 1, "server-session", "buy_now"), last_at: "2026-09-28T12:00:00.000Z" },
      { ...event(A, "public_auction_submission_created", 1, "server-session", "offer"), last_at: "2026-09-25T12:00:00.000Z" },
      { ...event(A, "public_auction_submission_created", 2, "server-session", "message"), last_at: "2026-09-26T12:00:00.000Z" },
      { ...event(A, "public_auction_submission_created", 1, "server-session", "buy_now"), last_at: "2026-09-27T12:00:00.000Z" },
      { ...event(B, "public_auction_submission_created", 1, "other-server-session", "offer"), last_at: "2026-09-29T12:00:00.000Z" },
    ]);
    expect(result.totals).toMatchObject({
      offer_events: 4, message_events: 3, buy_now_events: 2,
      offer_recipients: 1, message_recipients: 1, buy_now_recipients: 1,
      page_views: 0, visited_recipients: 0, sessions: 0,
    });
    const fpt = result.destinations.find((destination) => destination.cta_key === "fpt")!;
    expect(fpt.people.find((person) => person.person_id === "p1")).toMatchObject({
      offer_events: 3, message_events: 3, buy_now_events: 2,
      last_offer_at: "2026-09-26T12:00:00.000Z",
      last_message_at: "2026-09-27T12:00:00.000Z",
      last_buy_now_at: "2026-09-28T12:00:00.000Z",
      first_browser_at: null, last_browser_at: null, page_views: 0, sessions: 0,
    });
    expect(fpt.people.find((person) => person.person_id === "p2")).toMatchObject({
      last_offer_at: null, last_message_at: null, last_buy_now_at: null,
    });
    expect(result.destinations.find((destination) => destination.cta_key === "grid")?.people[0]).toMatchObject({
      offer_events: 1, message_events: 0, buy_now_events: 0,
      last_offer_at: "2026-09-29T12:00:00.000Z", last_message_at: null, last_buy_now_at: null,
      first_browser_at: null, last_browser_at: null, page_views: 0, sessions: 0,
    });
  });

  it("excludes removed recipients and manifest-only CTAs from the accepted retained attribution cohort", () => {
    const extra = structuredClone(manifest);
    extra.recipients[0].links = { ...extra.recipients[0].links, unknown: { link_id: "e".repeat(32) } } as typeof extra.recipients[0]["links"];
    const mapped = mapCampaignManifest(extra, ledger);
    expect(mapped.map((link) => link.link_id)).toEqual([A, B, C]);
    expect(mapped.some((link) => link.person_id === "removed")).toBe(false);
  });

  it.each(["campaign", "email", "person", "duplicate-link"])("fails closed on %s identity mismatch", (mutation) => {
    const bad = structuredClone(manifest);
    if (mutation === "campaign") { bad.campaign_id = "another-campaign"; }
    if (mutation === "email") { bad.recipients[0].email = "another@example.test"; }
    if (mutation === "person") { bad.recipients[0].person_id = "wrong-person"; }
    if (mutation === "duplicate-link") { bad.recipients[1].links.fpt.link_id = A; }
    expect(() => mapCampaignManifest(bad, ledger)).toThrow();
  });

  it("distinguishes verified available zero from provider failure without revealing errors", async () => {
    await writeFile(join(root, "send-manifest.json"), JSON.stringify(manifest));
    const available = await getCampaignActivity(ledger.campaign_id);
    expect(available).toMatchObject({ status: "available", totals: { redirect_events: 0, sessions: 0, page_views: 0 }, observed_at: END });
    queryProvider.mockRejectedValueOnce(new CampaignPostHogError("provider_incomplete"));
    const incomplete = await getCampaignActivity(ledger.campaign_id);
    expect(incomplete).toMatchObject({ status: "unavailable", unavailable_reason: "provider_incomplete", totals: null, destinations: [], observed_at: null });
    queryProvider.mockRejectedValueOnce(new CampaignPostHogError("provider_unavailable"));
    expect(await getCampaignActivity(ledger.campaign_id)).toMatchObject({ status: "unavailable", unavailable_reason: "provider_unavailable", totals: null });
  });

  it("returns null only for a missing campaign; missing/mismatched manifests retain safe campaign status", async () => {
    expect(await getCampaignActivity(ledger.campaign_id)).toMatchObject({ status: "unmapped", unavailable_reason: "manifest_missing", totals: null });
    await writeFile(join(root, "send-manifest.json"), JSON.stringify({ ...manifest, campaign_id: "wrong" }));
    expect(await getCampaignActivity(ledger.campaign_id)).toMatchObject({ status: "unavailable", unavailable_reason: "manifest_invalid", totals: null });
    expect(queryProvider).not.toHaveBeenCalled();
    readLedger.mockResolvedValueOnce(null);
    expect(await getCampaignActivity("missing")).toBeNull();
  });

  it("discovers only campaign-matching shallow manifests and rejects ambiguous matches", async () => {
    vi.stubEnv("CRM_CAMPAIGN_MANIFEST_PATH", "");
    vi.stubEnv("CRM_CAMPAIGN_MANIFEST_DIR", root);
    await mkdir(join(root, "customer"));
    await writeFile(join(root, "customer", "buyers-send-manifest.json"), JSON.stringify(manifest));
    expect(await getCampaignActivity(ledger.campaign_id)).toMatchObject({ status: "available" });
    await writeFile(join(root, "second-send-manifest.json"), JSON.stringify(manifest));
    expect(await getCampaignActivity(ledger.campaign_id)).toMatchObject({ status: "unavailable", unavailable_reason: "manifest_invalid", totals: null });
  });

  it("caps attribution to the actual thirty-day send-link lifetime", async () => {
    await writeFile(join(root, "send-manifest.json"), JSON.stringify(manifest));
    vi.setSystemTime(new Date("2026-12-01T00:00:00Z"));
    const result = await getCampaignActivity(ledger.campaign_id);
    expect(result?.period_start).toBe(START);
    expect(result?.period_end).toBe("2026-10-24T15:00:00.000Z");
  });
});
