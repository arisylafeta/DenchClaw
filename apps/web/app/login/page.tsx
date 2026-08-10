"use client";

import { FormEvent, useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { getSafeLoginDestination } from "@/lib/login-destination";

const inputClass =
  "h-[44px] w-full rounded-[10px] border border-black/10 bg-white px-3.5 text-[14px] text-stone-950 " +
  "shadow-[0_1px_2px_rgba(0,0,0,0.04)] outline-none transition-[border-color,box-shadow] " +
  "placeholder:text-stone-400 focus:border-[var(--color-accent)] focus:shadow-[0_0_0_3px_var(--color-accent-light)]";

function BrandPanel() {
  const clusters = [
    { left: "-12%", top: "-8%", size: "62%", opacity: 0.5 },
    { left: "48%", top: "8%", size: "58%", opacity: 0.36 },
    { left: "10%", top: "55%", size: "70%", opacity: 0.42 },
    { left: "70%", top: "66%", size: "45%", opacity: 0.3 },
  ];

  return (
    <aside className="relative hidden min-h-screen flex-1 overflow-hidden border-r border-black/5 bg-stone-100 md:flex">
      <div
        aria-hidden="true"
        className="absolute inset-0"
        style={{
          background:
            "linear-gradient(155deg, #fafaf8 0%, #f2f2ec 48%, #eceee3 100%)",
        }}
      />
      <div aria-hidden="true" className="absolute inset-0 overflow-hidden">
        {clusters.map((cluster, index) => (
          <div
            key={index}
            className="absolute rounded-full"
            style={{
              left: cluster.left,
              top: cluster.top,
              width: cluster.size,
              aspectRatio: "1",
              opacity: cluster.opacity,
              backgroundImage:
                "radial-gradient(circle, rgba(104,112,0,0.48) 1.5px, transparent 1.9px)",
              backgroundSize: "18px 18px",
              maskImage:
                "radial-gradient(circle at center, black 0%, rgba(0,0,0,0.82) 38%, transparent 72%)",
              WebkitMaskImage:
                "radial-gradient(circle at center, black 0%, rgba(0,0,0,0.82) 38%, transparent 72%)",
            }}
          />
        ))}
      </div>

      <div className="relative z-10 flex min-h-screen w-full flex-col px-10 py-10 lg:px-16 lg:py-12">
        <div className="my-auto max-w-[500px] py-16">
          <p className="mb-6 text-[11px] font-semibold uppercase tracking-[0.2em] text-stone-500">
            ReBattery workspace
          </p>
          <h2 className="max-w-[460px] text-[38px] leading-[1.12] font-medium tracking-[-0.035em] text-stone-950 lg:text-[46px]">
            Everything moving ReBattery forward, in one place.
          </h2>
          <p className="mt-6 max-w-[390px] text-[15px] leading-[1.7] text-stone-600">
            Manage projects, buyer conversations, and operations from a focused,
            private workspace.
          </p>
        </div>
        <p className="text-[11px] font-medium tracking-[0.08em] text-stone-500 uppercase">
          Private · Secure · Invite only
        </p>
      </div>
    </aside>
  );
}

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
    <main className="flex min-h-screen bg-white antialiased">
      <BrandPanel />

      <section className="flex min-h-screen w-full flex-col px-6 py-7 sm:px-9 md:w-[470px] md:shrink-0 md:px-12 md:py-9 lg:w-[540px] lg:px-20">
        <Image
          src="/rebattery-logo-all-black.svg"
          alt="ReBattery"
          width={103}
          height={18}
          className="h-[18px] w-auto"
          priority
          unoptimized
        />

        <div className="my-auto w-full py-14">
          <h1 className="text-[28px] font-semibold tracking-[-0.03em] text-stone-950">
            Welcome back
          </h1>
          <p className="mt-2 text-[14px] leading-relaxed text-stone-500">
            Sign in to your ReBattery CRM.
          </p>

          <form onSubmit={submit} className="mt-8 space-y-[18px]">
            <div>
              <label
                htmlFor="email"
                className="mb-1.5 block text-[13px] font-medium text-stone-700"
              >
                Work email
              </label>
              <input
                id="email"
                required
                type="email"
                autoComplete="email"
                placeholder="you@rebattery.io"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                className={inputClass}
              />
            </div>

            <div>
              <label
                htmlFor="password"
                className="mb-1.5 block text-[13px] font-medium text-stone-700"
              >
                Password
              </label>
              <input
                id="password"
                required
                type="password"
                autoComplete="current-password"
                placeholder="Enter your password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className={inputClass}
              />
            </div>

            {error ? (
              <p
                role="alert"
                aria-live="polite"
                className="rounded-[10px] border border-red-200 bg-red-50 px-3.5 py-2.5 text-[13px] text-red-700"
              >
                {error}
              </p>
            ) : null}

            <button
              type="submit"
              disabled={submitting}
              aria-busy={submitting}
              className="flex h-[44px] w-full items-center justify-center rounded-[10px] bg-stone-950 text-[14px] font-semibold tracking-[-0.01em] text-white shadow-[0_1px_2px_rgba(0,0,0,0.1)] transition-colors hover:bg-[var(--color-accent-hover)] disabled:cursor-wait disabled:opacity-65"
            >
              {submitting ? "Signing in…" : "Sign in"}
            </button>
          </form>

          <p className="mt-7 text-center text-[12px] leading-relaxed text-stone-400">
            Access is limited to invited ReBattery team members.
          </p>
        </div>

        <p className="text-center text-[11.5px] text-stone-400 md:text-left">
          © 2026 ReBattery Ltd
        </p>
      </section>
    </main>
  );
}
