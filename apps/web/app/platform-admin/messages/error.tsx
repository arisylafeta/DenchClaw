"use client";

export default function MessagesError({ reset }: { reset: () => void }) {
  return (
    <main className="flex min-h-full items-center justify-center bg-[var(--color-bg)] p-6">
      <div className="max-w-md rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6 text-center shadow-sm">
        <h1 className="text-lg font-semibold text-[var(--color-text)]">Message monitoring is unavailable</h1>
        <p className="mt-2 text-sm text-[var(--color-text-muted)]">The protected marketplace read did not complete. Retry without changing message state.</p>
        <button type="button" onClick={reset} className="mt-5 rounded-xl bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-white">Try again</button>
      </div>
    </main>
  );
}
