// @vitest-environment jsdom
import styles from "./campaign-surface.module.css";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CampaignEngagement } from "@/lib/crm-postgres/campaign-engagement";
import { CampaignEngagementRanking } from "./campaign-engagement-ranking";

const row = (overrides: Partial<CampaignEngagement>): CampaignEngagement => ({
  recipient_key: "p1", person_id: "p1", person_name: "Returning reader", company_name: "Example Ltd",
  recipient_email: "reader@example.com", total_opens: 4, flagged_opens: 0, return_sessions: 2,
  first_opened: null, days_to_first_open: null, late_opener: false,
  last_opened: "2026-10-08T12:00:00Z", human_links_clicked: 0, flagged_clicks: 0, replied: true, likely_bot: false,
  ...overrides,
});
afterEach(cleanup);

describe("campaign engagement ranking", () => {
  it("sorts by returns then human links, supports sorting and not-replied filtering, and navigates people", () => {
    const navigate = vi.fn();
    render(<CampaignEngagementRanking onNavigateEntry={navigate} rows={[
      row({ recipient_key: "p2", person_id: "p2", person_name: "Click reader", return_sessions: 1, human_links_clicked: 3, replied: false }),
      row({}),
    ]} />);
    const names = () => screen.getAllByRole("row").slice(1).map((tr) => within(tr).getByRole("link").textContent);
    expect(screen.getByRole("table").parentElement?.parentElement).toHaveClass(styles.tableFrame);
    expect(screen.getByRole("table").parentElement).toHaveClass("overflow-x-auto");
    expect(names()).toEqual(["Returning reader", "Click reader"]);
    fireEvent.change(screen.getByLabelText("Sort by"), { target: { value: "human_links_clicked" } });
    expect(names()).toEqual(["Click reader", "Returning reader"]);
    fireEvent.click(screen.getByLabelText("Not replied"));
    expect(names()).toEqual(["Click reader"]);
    fireEvent.click(screen.getByRole("link", { name: "Click reader" }));
    expect(navigate).toHaveBeenCalledWith("people", "p2");
    expect(screen.getByText("Returning readers")).toBeInTheDocument();
    expect(screen.getByText(/not verified people or site visits/)).toBeInTheDocument();
  });

  it("shows flagged activity and handles recipients without a CRM person", () => {
    render(<CampaignEngagementRanking rows={[row({ person_id: null, person_name: null, likely_bot: true, flagged_opens: 4, flagged_clicks: 5 })]} />);
    expect(screen.getByText("Likely bot")).toBeInTheDocument();
    expect(screen.getByText("reader@example.com")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Flagged clicks" })).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Not replied"));
    expect(screen.getByText("No recipients match this ranking.")).toBeInTheDocument();
  });

  it("shows send-to-open delay, late openers and unknown delays", () => {
    render(<CampaignEngagementRanking rows={[
      row({ days_to_first_open: 1.5, late_opener: true }),
      row({ recipient_key: "p2", person_id: "p2", person_name: "Unknown delay" }),
    ]} />);
    expect(screen.getByRole("columnheader", { name: "Days to open" })).toBeInTheDocument();
    expect(screen.getByText("1.50")).toBeInTheDocument();
    expect(screen.getByText("Late opener")).toHaveAttribute("title", "First open more than 24 hours after this message was sent");
    expect(screen.getByText("Not observed")).toBeInTheDocument();
  });

  it("renders the empty state", () => {
    render(<CampaignEngagementRanking rows={[]} />);
    expect(screen.getByText("No recipients match this ranking.")).toBeInTheDocument();
  });
});
