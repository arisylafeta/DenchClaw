// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AccountsClient } from "./accounts-client";
import { getAccountDetails } from "./actions";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

vi.mock("./actions", () => ({
  getAccountDetails: vi.fn(),
  deleteAccountsBulk: vi.fn(),
  deleteAccount: vi.fn(),
  updateAccountRole: vi.fn(),
  updateAccountRolesBulk: vi.fn(),
  updateAccountStatus: vi.fn(),
  updateAccountStatusesBulk: vi.fn(),
  sendEmailToAccounts: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), message: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

const accounts = [
  {
    id: "account-1",
    name: "Acme Recycling",
    email: "ops@acme.test",
    role: "recycler" as const,
    account_type: "organization" as const,
    status: "active" as const,
    created_at: "2026-08-01T00:00:00.000Z",
    display_name: "Acme",
    location: "London, United Kingdom",
  },
  {
    id: "account-2",
    name: "Battery Buyer",
    email: "buyer@example.test",
    role: "buyer" as const,
    account_type: "organization" as const,
    status: "pending" as const,
    created_at: "2026-08-02T00:00:00.000Z",
    display_name: null,
    location: "Manchester, United Kingdom",
  },
];

describe("AccountsClient", () => {
  beforeEach(() => {
    vi.mocked(getAccountDetails).mockReset();
  });

  it("searches the shared account table", async () => {
    const user = userEvent.setup();
    render(<AccountsClient accounts={accounts} />);

    await user.type(screen.getByPlaceholderText("Search accounts..."), "Acme");

    expect(screen.getByText("Acme Recycling")).toBeInTheDocument();
    expect(screen.queryByText("Battery Buyer")).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Filter by role" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Filter by status" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Filter by type" })).toBeInTheDocument();
  });

  it("opens account details as a full shared view and returns to the list", async () => {
    const user = userEvent.setup();
    vi.mocked(getAccountDetails).mockResolvedValue({
      success: true,
      data: {
        account: {
          id: "account-1",
          name: "Acme Recycling",
          role: "recycler",
          account_type: "organization",
          status: "active",
          sector: null,
          created_at: "2026-08-01T00:00:00.000Z",
          updated_at: "2026-08-10T00:00:00.000Z",
          stripe_connect_status: "active",
          stripe_connect_account_id: "acct_123",
          stripe_connect_onboarded_at: "2026-08-05T00:00:00.000Z",
        },
        publicProfile: {
          display_name: "Acme",
          about: "A recycler",
          website_url: "https://acme.test",
          seo_slug: "acme",
          public_fields_json: { fleet_size: 12 },
        },
        privateProfile: {
          addresses_json: [],
          ops_json: { review_note: "Priority recycler" },
          tax_registered: true,
          tax_id: "GB123",
          company_number: "12345678",
          billing_address: { city: "Dover", country: "United Kingdom" },
          created_at: "2026-08-01T00:00:00.000Z",
          updated_at: "2026-08-10T00:00:00.000Z",
        },
        members: [{
          user_id: "user-1",
          membership_role: "owner",
          is_primary: true,
          joined_at: "2026-08-01T00:00:00.000Z",
          email: "ops@acme.test",
          full_name: "Alex Operator",
          phone_number: "+44 20 1234 5678",
          position: "Director",
          status: "active",
        }],
      },
    });

    render(<AccountsClient accounts={accounts} />);
    await user.click(screen.getByText("Acme Recycling"));
    expect(getAccountDetails).toHaveBeenCalledWith("account-1");

    expect(await screen.findByRole("button", { name: "Back to Accounts" })).toBeInTheDocument();
    expect(await screen.findByText("A recycler")).toBeInTheDocument();
    expect(screen.getByText("Alex Operator")).toBeInTheDocument();
    expect(screen.getByText("Dover, United Kingdom")).toBeInTheDocument();
    expect(screen.getByText("acct_123")).toBeInTheDocument();
    expect(screen.getByText("+44 20 1234 5678")).toBeInTheDocument();
    expect(screen.getByText("Priority recycler")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Back to Accounts" }));
    await waitFor(() => expect(screen.getByPlaceholderText("Search accounts...")).toBeInTheDocument());
  });
});
