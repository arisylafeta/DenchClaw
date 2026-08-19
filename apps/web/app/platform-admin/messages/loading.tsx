export default function MessagesLoading() {
  return (
    <main className="min-h-full bg-[var(--color-bg)] p-4 sm:p-6">
      <div className="mx-auto max-w-[1800px] animate-pulse space-y-5">
        <div className="h-8 w-72 rounded bg-[var(--color-surface-hover)]" />
        <div className="h-24 rounded-2xl bg-[var(--color-surface-hover)]" />
        <div className="h-[28rem] rounded-2xl bg-[var(--color-surface-hover)]" />
      </div>
    </main>
  );
}
