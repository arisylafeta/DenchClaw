"use client";

import { useState } from "react";
import type { Json } from "@/lib/platform-admin/database.types";
import { CrmEmptyState, CrmListShell } from "@/app/components/crm/crm-list-shell";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/app/components/platform-admin/ui/sheet";
import { getBatteryInquiryChat, type BatteryInquiryChat } from "./actions";
import type { BatteryRequest, BatteryRequestPage } from "./reads";

const PATH = "/platform-admin/battery-requests";
const actionClass =
  "inline-flex h-8 items-center justify-center rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-xs font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-hover)] focus-visible:outline-2 focus-visible:outline-offset-2";

function label(key: string): string {
  const text = key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function SavedValue({ value, depth = 0 }: { value: Json | undefined; depth?: number }) {
  if (value === null || value === undefined || value === "") {
    return <span className="text-[var(--color-text-muted)]">Not provided</span>;
  }
  if (typeof value === "boolean") {
    return <>{value ? "Yes" : "No"}</>;
  }
  if (typeof value !== "object") {
    return (
      <span className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
        {String(value)}
      </span>
    );
  }
  if (depth >= 8) {
    return <pre className="whitespace-pre-wrap break-words">{JSON.stringify(value, null, 2)}</pre>;
  }
  if (Array.isArray(value)) {
    return value.length ? (
      <ul className="list-disc space-y-1 pl-5">
        {value.map((item, index) => (
          <li key={index}>
            <SavedValue value={item} depth={depth + 1} />
          </li>
        ))}
      </ul>
    ) : (
      <span>None recorded</span>
    );
  }
  return (
    <dl className="space-y-3">
      {Object.entries(value).map(([key, item]) => (
        <div key={key} className="grid gap-1 sm:grid-cols-[10rem_minmax(0,1fr)]">
          <dt className="text-[var(--color-text-muted)]">{label(key)}</dt>
          <dd className="min-w-0">
            <SavedValue value={item} depth={depth + 1} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

function description(value: Json): string {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const stock = value.stock;
    if (
      stock &&
      typeof stock === "object" &&
      !Array.isArray(stock) &&
      typeof stock.description === "string" &&
      stock.description.trim()
    ) {
      return stock.description;
    }
  }
  return "Battery details not provided";
}

function date(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? "Date unavailable"
    : new Intl.DateTimeFormat("en-GB", {
        timeZone: "UTC",
        dateStyle: "medium",
        timeStyle: "short",
      }).format(parsed) + " UTC";
}

function pageHref(page: number, email: string): string {
  const params = new URLSearchParams({ page: String(page) });
  if (email) {
    params.set("email", email);
  }
  return `${PATH}?${params}`;
}

export function BatteryRequestsView({ data }: { data: BatteryRequestPage }) {
  const [selectedInquiry, setSelectedInquiry] = useState<BatteryRequest | null>(null);
  const [chat, setChat] = useState<BatteryInquiryChat | null>(null);
  const [chatPending, setChatPending] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);

  const openChat = async (inquiry: BatteryRequest) => {
    setSelectedInquiry(inquiry);
    setChat(null);
    setChatError(null);
    setChatPending(true);
    try {
      const loadedChat = await getBatteryInquiryChat(inquiry.id);
      if (loadedChat) {
        setChat(loadedChat);
      } else {
        setChatError("This inquiry is no longer available.");
      }
    } catch {
      setChatError("The inquiry chat could not be loaded.");
    } finally {
      setChatPending(false);
    }
  };

  return (
    <CrmListShell
      title="Battery requests"
      count={data.totalCount}
      toolbar={
        <a className={actionClass} href={pageHref(data.page, data.email)}>
          Refresh
        </a>
      }
    >
      <main className="mx-auto max-w-5xl space-y-5 p-4 text-sm text-[var(--color-text)] sm:p-6">
        <p className="text-[var(--color-text-muted)]">
          Saved requests from Joules, newest first. Open a request to read the submitted details.
        </p>
        <form action={PATH} method="get" className="flex flex-wrap items-end gap-2" role="search">
          <label className="grid flex-1 gap-1 text-xs font-medium" htmlFor="request-email">
            Contact email
            <input
              id="request-email"
              name="email"
              defaultValue={data.email}
              placeholder="Search by email"
              maxLength={254}
              className="h-9 min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm"
            />
          </label>
          <button type="submit" className={actionClass}>
            Search
          </button>
          {data.email && (
            <a href={PATH} className={actionClass}>
              Clear
            </a>
          )}
        </form>
        {data.rows.length === 0 ? (
          <CrmEmptyState
            title={data.email ? "No matching requests" : "No battery requests yet"}
            description={
              data.email
                ? "Try a different email address or clear the search."
                : "Requests will appear here after a visitor submits them in Joules."
            }
          />
        ) : (
          <div className="space-y-3">
            {data.rows.map((request) => (
              <div
                key={request.id}
                className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]"
              >
                <details className="group">
                  <summary className="cursor-pointer rounded-xl p-4 focus-visible:outline-2 focus-visible:outline-offset-2">
                    <span className="ml-1 font-medium break-all">
                      {request.contact_email || "Email not provided"}
                    </span>
                    <span className="ml-3 rounded border border-[var(--color-border)] px-2 py-0.5 text-xs">
                      {label(request.intent) || "Intent not provided"}
                    </span>
                    <p className="mt-2 line-clamp-2 text-sm text-[var(--color-text-muted)]">
                      {description(request.request_json)}
                    </p>
                    <time
                      dateTime={request.created_at}
                      className="mt-2 block text-xs text-[var(--color-text-muted)]"
                    >
                      {date(request.created_at)}
                    </time>
                    <span className="mt-2 block text-xs font-medium group-open:hidden">
                      View inquiry
                    </span>
                  </summary>
                  <div className="space-y-4 border-t border-[var(--color-border)] p-4">
                    <h2 className="font-medium">Submitted details</h2>
                    <SavedValue value={request.request_json} />
                    <p className="break-all text-xs text-[var(--color-text-muted)]">
                      Inquiry reference: {request.id}
                    </p>
                  </div>
                </details>
                <div className="border-t border-[var(--color-border)] p-3">
                  <button
                    type="button"
                    className={actionClass}
                    aria-label={`View chat with ${request.contact_email || "visitor"}`}
                    onClick={() => void openChat(request)}
                  >
                    View chat
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
        <nav aria-label="Request pages" className="flex items-center justify-between gap-3 text-xs">
          <span>
            Page {data.page} of {data.totalPages}
          </span>
          <div className="flex gap-2">
            {data.page > 1 && (
              <a className={actionClass} href={pageHref(data.page - 1, data.email)}>
                Previous
              </a>
            )}
            {data.page < data.totalPages && (
              <a className={actionClass} href={pageHref(data.page + 1, data.email)}>
                Next
              </a>
            )}
          </div>
        </nav>
        <Sheet
          open={Boolean(selectedInquiry)}
          onOpenChange={(open) => {
            if (!open) {
              setSelectedInquiry(null);
              setChat(null);
              setChatError(null);
            }
          }}
        >
          <SheetContent className="w-full gap-0 p-0 sm:max-w-xl">
            <SheetHeader className="border-b border-[var(--color-border)] pr-14">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--color-text-muted)]">
                Joules inquiry chat
              </p>
              <SheetTitle>
                Chat with {selectedInquiry?.contact_email || "visitor"}
              </SheetTitle>
              <SheetDescription>
                {chat
                  ? `${chat.messages.length} ${chat.messages.length === 1 ? "message" : "messages"} · submitted ${date(chat.createdAt)}`
                  : selectedInquiry
                    ? `Submitted ${date(selectedInquiry.created_at)}`
                    : "Saved Joules conversation"}
              </SheetDescription>
            </SheetHeader>
            <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
              {chatPending ? (
                <p role="status" className="text-sm text-[var(--color-text-muted)]">
                  Loading chat…
                </p>
              ) : chatError ? (
                <p role="alert" className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
                  {chatError}
                </p>
              ) : chat?.messages.length ? (
                <ol aria-label="Joules chat transcript" className="space-y-4">
                  {chat.messages.map((message) => {
                    const isVisitor = message.role === "user";
                    return (
                      <li
                        key={message.id}
                        className={`flex flex-col ${isVisitor ? "items-end" : "items-start"}`}
                      >
                        <span className="mb-1 text-xs font-medium text-[var(--color-text-muted)]">
                          {isVisitor ? "Visitor" : "Joules"}
                        </span>
                        <div
                          className={`max-w-[88%] rounded-2xl px-4 py-3 ${
                            isVisitor
                              ? "rounded-br-md bg-[var(--color-accent-fill)] text-[var(--color-accent-foreground)]"
                              : "rounded-bl-md bg-[var(--color-surface-hover)] text-[var(--color-text)]"
                          }`}
                        >
                          <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                            {message.body}
                          </p>
                        </div>
                        <time
                          dateTime={message.createdAt}
                          className="mt-1 text-[11px] text-[var(--color-text-muted)]"
                        >
                          {date(message.createdAt)}
                        </time>
                      </li>
                    );
                  })}
                </ol>
              ) : (
                <p className="text-sm text-[var(--color-text-muted)]">
                  No chat messages were saved for this inquiry.
                </p>
              )}
            </div>
          </SheetContent>
        </Sheet>
      </main>
    </CrmListShell>
  );
}
