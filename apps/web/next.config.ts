import type { NextConfig } from "next";
import { readFileSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { createRequire } from "node:module";

const rootPkg = JSON.parse(
  readFileSync(path.join(import.meta.dirname, "..", "..", "package.json"), "utf-8"),
) as { version?: string };

let openclawVersion = "";
try {
  const req = createRequire(import.meta.url);
  const oclPkg = req("openclaw/package.json") as { version?: string };
  openclawVersion = oclPkg.version ?? "";
} catch { /* openclaw not resolvable at build time */ }

const denchVersion = rootPkg.version ?? "";

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_DENCHCLAW_VERSION: denchVersion,
    NEXT_PUBLIC_OPENCLAW_VERSION: openclawVersion,
  },

  async headers() {
    return [
      {
        source: "/((?!_next/static|_next/image|favicon\\.ico).*)",
        headers: [{ key: "X-Denchclaw-Version", value: denchVersion }],
      },
    ];
  },

  // Produce a self-contained standalone build so npm global installs
  // can run the web app with `node server.js` — no npm install or
  // next build required at runtime.
  output: "standalone",

  // Required for pnpm monorepos: trace dependencies from the workspace
  // root so the standalone build bundles its own node_modules correctly
  // instead of resolving through pnpm's virtual store symlinks.
  outputFileTracingRoot: path.join(import.meta.dirname, "..", ".."),

  // Campaign attribution reads private runtime files, never packaged credentials or manifests.
  outputFileTracingExcludes: {
    "/*": [
      path.relative(import.meta.dirname, process.env.CRM_POSTHOG_CREDENTIALS_PATH || path.join(homedir(), ".posthog", "credentials.json")),
      `${path.relative(import.meta.dirname, process.env.CRM_CAMPAIGN_MANIFEST_DIR || path.join(homedir(), ".hermes", "workspace", "campaigns"))}/**`,
      ...(process.env.CRM_CAMPAIGN_MANIFEST_PATH ? [path.relative(import.meta.dirname, process.env.CRM_CAMPAIGN_MANIFEST_PATH)] : []),
    ],
  },

  // Externalize packages with native addons so webpack doesn't break them
  serverExternalPackages: ["ws", "bufferutil", "utf-8-validate", "node-pty"],

  // Transpile ESM-only packages so webpack can bundle them
  transpilePackages: ["react-markdown", "remark-gfm"],

  experimental: {
    // Requests pass through middleware, which buffers bodies up to 10 MB by default. Bulk Trades
    // uploads allow 25 MB (MAX_TRADE_FILE_BYTES) plus multipart overhead.
    middlewareClientMaxBodySize: "26mb",
  },

  // Turbopack equivalent of the webpack `resolve.fallback` below — html-to-docx
  // imports Node built-ins at the top of its ESM bundle that should be no-ops
  // in browser bundles. Scoped to `browser` so server bundles still get the
  // real Node modules.
  turbopack: {
    resolveAlias: {
      fs: { browser: "./lib/empty-module.js" },
      path: { browser: "./lib/empty-module.js" },
      crypto: { browser: "./lib/empty-module.js" },
      stream: { browser: "./lib/empty-module.js" },
      http: { browser: "./lib/empty-module.js" },
      https: { browser: "./lib/empty-module.js" },
      url: { browser: "./lib/empty-module.js" },
      zlib: { browser: "./lib/empty-module.js" },
      util: { browser: "./lib/empty-module.js" },
      events: { browser: "./lib/empty-module.js" },
      punycode: { browser: "./lib/empty-module.js" },
      encoding: { browser: "./lib/empty-module.js" },
    },
  },

  webpack: (config, { dev, isServer }) => {
    if (!isServer) {
      // html-to-docx references Node-only modules that should not be resolved in browser bundles.
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        encoding: false,
      };
    }
    if (dev) {
      config.watchOptions = {
        ...config.watchOptions,
        ignored: [
          "**/node_modules/**",
          "**/.git/**",
          "**/dist/**",
          "**/.next/**",
          path.join(homedir(), ".openclaw", "**"),
          path.join(homedir(), ".openclaw-*", "**"),
        ],
        poll: 1500,
      };
    }
    return config;
  },
};

export default nextConfig;
