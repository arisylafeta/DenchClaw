"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { getSafeLoginDestination } from "@/lib/login-destination";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const router = useRouter();

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (!response.ok) {
        setError(
          response.status === 503
            ? "Login is temporarily unavailable. Please try again."
            : "Email or password is incorrect.",
        );
        return;
      }
      const next = new URLSearchParams(window.location.search).get("next");
      router.replace(getSafeLoginDestination(next, window.location.origin));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main
      className="flex min-h-screen items-center justify-center px-6 py-12"
      style={{ background: "var(--color-main-bg)" }}
    >
      <section
        className="w-full max-w-sm rounded-2xl border p-8 shadow-sm"
        style={{
          background: "var(--color-surface)",
          borderColor: "var(--color-border)",
        }}
      >
        <div className="mb-8 flex items-center gap-3">
          <img
            src="/rebattery-workspace-icon.svg"
            alt=""
            width={40}
            height={40}
            className="rounded-lg"
          />
          <div>
            <h1
              className="text-xl font-semibold"
              style={{ color: "var(--color-text)" }}
            >
              CRM
            </h1>
            <p className="text-sm" style={{ color: "var(--color-text-muted)" }}>
              Sign in to your ReBattery workspace
            </p>
          </div>
        </div>

        <form onSubmit={submit} className="space-y-5">
          <label className="block space-y-2 text-sm font-medium">
            <span style={{ color: "var(--color-text)" }}>Email</span>
            <input
              required
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="h-11 w-full rounded-lg border px-3 outline-none transition-shadow focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-accent-light)]"
              style={{
                color: "var(--color-text)",
                background: "var(--color-surface)",
                borderColor: "var(--color-border)",
              }}
            />
          </label>

          <label className="block space-y-2 text-sm font-medium">
            <span style={{ color: "var(--color-text)" }}>Password</span>
            <input
              required
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="h-11 w-full rounded-lg border px-3 outline-none transition-shadow focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-accent-light)]"
              style={{
                color: "var(--color-text)",
                background: "var(--color-surface)",
                borderColor: "var(--color-border)",
              }}
            />
          </label>

          {error && (
            <p
              role="alert"
              className="rounded-lg px-3 py-2 text-sm"
              style={{
                color: "var(--color-error)",
                background: "rgba(220, 38, 38, 0.08)",
              }}
            >
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="h-11 w-full rounded-lg text-sm font-semibold transition-opacity disabled:opacity-60"
            style={{
              background: "var(--color-accent-fill)",
              color: "var(--color-accent-foreground)",
            }}
          >
            {submitting ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </section>
    </main>
  );
}
