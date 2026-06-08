const DENCH_URL = "https://dench.com";

export function DeprecationBanner() {
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="deprecation-banner"
      className="relative z-[10000] border-b px-4 py-2 sm:px-6"
      style={{
        background: "var(--color-deprecation-bg)",
        borderColor: "var(--color-deprecation-border)",
      }}
    >
      <p
        className="mx-auto max-w-6xl text-center text-[12.5px] leading-snug sm:text-[13px]"
        style={{ color: "var(--color-deprecation-muted)" }}
      >
        You can still use DenchClaw, but it won&apos;t receive updates. for the latest features, go to{" "}
        <a
          href={DENCH_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="font-semibold underline decoration-[var(--color-deprecation-border)] underline-offset-2 transition-opacity hover:opacity-80"
          style={{ color: "var(--color-deprecation-text)" }}
          data-testid="deprecation-banner-cta"
        >
          dench.com
        </a>
        .
      </p>
    </div>
  );
}
