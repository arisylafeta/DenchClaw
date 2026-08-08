"use client";

/**
 * Right-side preview for Step 2 (Setup). A concentric-orbit diagram with
 * the DenchClaw mark in the center and the integrations DenchClaw can
 * connect to scattered along dotted rings. Pure decoration — the actual
 * connection state lives on the left.
 *
 * Implementation notes:
 * - Three concentric dotted circles drawn in a background SVG that fills
 *   the pane. Stroke uses `--color-border` so it adapts to theme.
 * - Brand logos are absolutely positioned on top with a tiny "coin"
 *   behind each so that mono marks (GitHub, OpenAI) are legible in dark
 *   mode and the multicolor ones have a quiet backdrop so they don't
 *   float awkwardly.
 * - No animations for now (respects reduced-motion by default and keeps
 *   the visual calm on repeat views).
 */
// Uniform visual size for all integration logos so Slack doesn't feel
// bigger than Calendar just because of how each brand packs its viewBox.
const NODE_SIZE = 40;
const DENCH_SIZE = 68;

export function PreviewOrbit() {
  return (
    <div className="relative h-full w-full overflow-hidden">
      {/* Dotted rings. viewBox 800x800 → easy positional math. Stroke uses a
          mix of --color-text so the orbit reads clearly on light mode while
          staying subtle in dark mode. */}
      <svg
        className="absolute inset-0 h-full w-full"
        viewBox="0 0 800 800"
        preserveAspectRatio="xMidYMid slice"
        aria-hidden
      >
        <g
          fill="none"
          stroke="color-mix(in oklab, var(--color-text) 22%, transparent)"
          strokeWidth="1.4"
          strokeDasharray="3 8"
          strokeLinecap="round"
        >
          <circle cx="400" cy="400" r="160" />
          <circle cx="400" cy="400" r="260" />
          <circle cx="400" cy="400" r="360" />
        </g>
      </svg>

      {/* Dench — naked in the center, no chip or shadow. */}
      <div
        className="absolute flex items-center justify-center"
        style={{
          left: "50%",
          top: "50%",
          width: DENCH_SIZE,
          height: DENCH_SIZE,
          transform: "translate(-50%, -50%)",
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/rebattery-workspace-icon.svg"
          alt=""
          width={DENCH_SIZE}
          height={DENCH_SIZE}
          draggable={false}
          style={{ width: "100%", height: "100%", objectFit: "contain" }}
        />
      </div>

      {/* Integrations. Angles are staggered across rings so no two nodes line
          up radially, which keeps the composition lively at a glance. */}
      {nodesOnRing(0.2, [
        { angle: 40, icon: <GmailLogo /> },
        { angle: 160, icon: <GoogleCalendarLogo /> },
        { angle: 280, icon: <SlackLogo /> },
      ])}
      {nodesOnRing(0.325, [
        { angle: 100, icon: <GitHubLogo /> },
        { angle: 220, icon: <SheetsLogo /> },
        { angle: 340, icon: <HubSpotLogo /> },
      ])}
      {nodesOnRing(0.45, [
        { angle: 20, icon: <StripeLogo /> },
        { angle: 140, icon: <ChatGPTLogo /> },
        { angle: 260, icon: <ApolloLogo /> },
      ])}
    </div>
  );
}

type RingNodeSpec = {
  angle: number; // degrees, 0 = right, counterclockwise
  icon: React.ReactNode;
};

function nodesOnRing(radiusPct: number, nodes: RingNodeSpec[]) {
  return nodes.map((node, i) => {
    const rad = (node.angle * Math.PI) / 180;
    const leftPct = 50 + radiusPct * 100 * Math.cos(rad);
    const topPct = 50 - radiusPct * 100 * Math.sin(rad);
    return (
      <OrbitNode
        key={`${radiusPct}-${i}`}
        left={`${leftPct}%`}
        top={`${topPct}%`}
      >
        {node.icon}
      </OrbitNode>
    );
  });
}

/**
 * Fixed-size slot for every integration. The inner wrapper centers the glyph
 * at a consistent optical weight regardless of how each brand pads its own
 * viewBox — this is what prevents Gmail-vs-GitHub size inconsistency.
 */
function OrbitNode({
  left,
  top,
  children,
}: {
  left: string;
  top: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className="absolute flex items-center justify-center"
      style={{
        left,
        top,
        width: NODE_SIZE,
        height: NODE_SIZE,
        transform: "translate(-50%, -50%)",
      }}
    >
      <div
        className="flex items-center justify-center"
        style={{ width: "100%", height: "100%" }}
      >
        {children}
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Brand logos. Each is rendered at 100% of its parent container so the
// OrbitNode sizing controls the visual weight.
// ────────────────────────────────────────────────────────────────────────

// Each brand packs its viewBox differently — some fill edge-to-edge, some
// are centered with slack. We scale per-logo so they all read at roughly the
// same optical weight inside the 40px node.
function Scaled({ pct, children }: { pct: number; children: React.ReactNode }) {
  return (
    <div
      className="flex items-center justify-center"
      style={{ width: `${pct}%`, height: `${pct}%` }}
    >
      {children}
    </div>
  );
}

function GmailLogo() {
  return (
    <Scaled pct={78}>
    <svg viewBox="0 0 256 193" xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" aria-hidden>
      <path d="M58.182 192.05V93.14L27.507 65.077 0 49.504v125.091c0 9.658 7.825 17.455 17.455 17.455h40.727Z" fill="#4285F4" />
      <path d="M197.818 192.05h40.727c9.659 0 17.455-7.826 17.455-17.455V49.505l-31.156 17.837-26.983 25.798-.043 98.91Z" fill="#34A853" />
      <path d="m58.182 93.14-4.174-38.655 4.174-36.945L128 69.868l69.818-52.327 4.67 34.14-4.67 41.46L128 145.467l-69.818-52.326Z" fill="#EA4335" />
      <path d="M197.818 17.538V93.14L256 49.504V26.272c0-21.564-24.61-33.858-41.89-20.89L197.818 17.54Z" fill="#FBBC04" />
      <path d="M0 49.504l26.759 20.069L58.182 93.14V17.538L41.89 5.382C24.59-7.587 0 4.708 0 26.27v23.233Z" fill="#C5221F" />
    </svg>
    </Scaled>
  );
}

function GoogleCalendarLogo() {
  return (
    <Scaled pct={98}>
    {/* eslint-disable-next-line @next/next/no-img-element */}
    <img
      src="/logos/google-calendar.png"
      alt=""
      draggable={false}
      style={{ width: "100%", height: "100%", objectFit: "contain" }}
    />
    </Scaled>
  );
}

function SlackLogo() {
  return (
    <Scaled pct={78}>
    <svg viewBox="0 0 54 54" xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" aria-hidden>
      <path d="M19.712.133a5.381 5.381 0 0 0-5.376 5.387 5.381 5.381 0 0 0 5.376 5.386h5.376V5.52A5.381 5.381 0 0 0 19.712.133m0 14.365H5.376A5.381 5.381 0 0 0 0 19.884a5.381 5.381 0 0 0 5.376 5.387h14.336a5.381 5.381 0 0 0 5.376-5.387 5.381 5.381 0 0 0-5.376-5.386" fill="#36C5F0" />
      <path d="M53.76 19.884a5.381 5.381 0 0 0-5.376-5.386 5.381 5.381 0 0 0-5.376 5.386v5.387h5.376a5.381 5.381 0 0 0 5.376-5.387m-14.336 0V5.52A5.381 5.381 0 0 0 34.048.133a5.381 5.381 0 0 0-5.376 5.387v14.364a5.381 5.381 0 0 0 5.376 5.387 5.381 5.381 0 0 0 5.376-5.387" fill="#2EB67D" />
      <path d="M34.048 54a5.381 5.381 0 0 0 5.376-5.387 5.381 5.381 0 0 0-5.376-5.386h-5.376v5.386A5.381 5.381 0 0 0 34.048 54m0-14.365h14.336a5.381 5.381 0 0 0 5.376-5.386 5.381 5.381 0 0 0-5.376-5.387H34.048a5.381 5.381 0 0 0-5.376 5.387 5.381 5.381 0 0 0 5.376 5.386" fill="#ECB22E" />
      <path d="M0 34.249a5.381 5.381 0 0 0 5.376 5.386 5.381 5.381 0 0 0 5.376-5.386v-5.387H5.376A5.381 5.381 0 0 0 0 34.25m14.336 0v14.364A5.381 5.381 0 0 0 19.712 54a5.381 5.381 0 0 0 5.376-5.387V34.25a5.381 5.381 0 0 0-5.376-5.387 5.381 5.381 0 0 0-5.376 5.387" fill="#E01E5A" />
    </svg>
    </Scaled>
  );
}

function GitHubLogo() {
  return (
    <Scaled pct={90}>
    <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" aria-hidden>
      <path
        d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"
        fill="var(--color-text)"
      />
    </svg>
    </Scaled>
  );
}

function StripeLogo() {
  return (
    <Scaled pct={86}>
    <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" aria-hidden>
      <path
        d="M13.976 9.15c-2.172-.806-3.356-1.426-3.356-2.409 0-.831.683-1.305 1.901-1.305 2.227 0 4.515.858 6.09 1.631l.89-5.494C18.252.975 15.697 0 12.165 0 9.667 0 7.589.654 6.105 1.874 4.554 3.147 3.756 4.992 3.756 7.218c0 4.039 2.467 5.76 6.476 7.219 2.585.92 3.445 1.582 3.445 2.585 0 .97-.832 1.531-2.345 1.531-1.974 0-5.16-.971-7.19-2.221L3.252 21.81C5.009 22.8 8.271 24 11.649 24c2.64 0 4.842-.624 6.401-1.815 1.744-1.322 2.648-3.273 2.648-5.625 0-4.134-2.528-5.86-6.722-7.411z"
        fill="#635BFF"
      />
    </svg>
    </Scaled>
  );
}

function ChatGPTLogo() {
  return (
    <Scaled pct={88}>
    <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" aria-hidden>
      <path
        d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654 2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"
        fill="var(--color-text)"
      />
    </svg>
    </Scaled>
  );
}

function SheetsLogo() {
  return (
    <Scaled pct={80}>
    <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" aria-hidden>
      <path
        d="M14.727 6.727H14V0H4.91c-.905 0-1.637.732-1.637 1.636v20.728c0 .904.732 1.636 1.636 1.636h14.182c.904 0 1.636-.732 1.636-1.636V6.727z"
        fill="#0F9D58"
      />
      <path d="M14 0v6.727h6.727z" fill="#0B7F46" />
      <path d="M7.091 10.364v8h9.818v-8zm1.09 6.909V16.09h3.273v1.182zm0-2.273v-1.182h3.273V15zm0-2.273V11.546h3.273v1.181zm4.364 4.546V16.09h3.273v1.182zm0-2.273v-1.182h3.273V15zm0-2.273V11.546h3.273v1.181z" fill="#F1F1F1" />
    </svg>
    </Scaled>
  );
}

function HubSpotLogo() {
  return (
    <Scaled pct={90}>
    <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" aria-hidden>
      <path
        d="M22.447 9.564a5.988 5.988 0 0 0-2.157-2.19 5.96 5.96 0 0 0-3.012-.81c-.174 0-.344.01-.514.025V4.45a1.847 1.847 0 0 0 1.06-1.665A1.848 1.848 0 0 0 15.979.938a1.847 1.847 0 0 0-1.847 1.847 1.846 1.846 0 0 0 1.061 1.666v2.14a5.94 5.94 0 0 0-1.765.55L5.935 1.24A2.306 2.306 0 1 0 4.8 3.24l7.362 5.73a5.97 5.97 0 0 0-.965 3.286 5.99 5.99 0 0 0 1.823 4.304L10.7 18.881a1.946 1.946 0 1 0 1.385 1.386l2.286-2.286a5.98 5.98 0 0 0 2.908.748 5.98 5.98 0 0 0 5.98-5.98 5.96 5.96 0 0 0-.812-3.185zm-5.168 5.787a2.858 2.858 0 1 1 0-5.716 2.858 2.858 0 0 1 0 5.716z"
        fill="#FF7A59"
      />
    </svg>
    </Scaled>
  );
}

// Same Apollo.io mark we use in the /integrations view so both surfaces stay
// consistent. Fill follows theme via currentColor (dark on light, light on dark).
function ApolloLogo() {
  return (
    <Scaled pct={82}>
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 64 64"
        width="100%"
        height="100%"
        aria-hidden
        style={{ color: "var(--color-text)" }}
      >
        <path
          fill="currentColor"
          d="M32.4,0l-24,49.6h7.8l16.2-33.9l15.5,33.9h7.7L32.4,0z M25.5,49.6L32.4,64l6.7-14.4H25.5z"
        />
      </svg>
    </Scaled>
  );
}
