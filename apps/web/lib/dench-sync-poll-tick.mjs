#!/usr/bin/env node
const webBaseUrl = (process.env.DENCHCLAW_WEB_BASE_URL?.trim() || "http://127.0.0.1:3100").replace(
  /\/$/,
  "",
);

const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 60_000);

try {
  const response = await fetch(`${webBaseUrl}/api/sync/refresh`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ mode: "incremental" }),
    signal: controller.signal,
  });
  const text = await response.text();
  if (!response.ok) {
    console.error(text || `HTTP ${response.status}`);
    process.exit(1);
  }
  console.log(text);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
} finally {
  clearTimeout(timeout);
}
