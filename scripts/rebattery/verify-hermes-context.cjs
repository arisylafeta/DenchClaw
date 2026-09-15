#!/usr/bin/env node
// Explicit, live deployment smoke check. Uses a synthetic session and two model turns.
// HERMES_API_BASE_URL / HERMES_API_KEY must be supplied by the operator.
// Loads the actual deployed webpack adapter, not a second implementation of it.
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { createRequire } = require("node:module");
const path = require("node:path");

async function main() {
  const runtimeRoot = process.argv[2];
  assert(runtimeRoot, "Usage: node verify-hermes-context.cjs <standalone apps/web directory>");
  assert(process.env.HERMES_API_KEY, "HERMES_API_KEY is required");
  const baseUrl = (process.env.HERMES_API_BASE_URL || "http://127.0.0.1:8642").replace(/\/+$/, "");
  const sessionId = `dench-context-smoke-${randomUUID()}`;
  const marker = `continuity-${randomUUID()}`;
  const server = path.resolve(runtimeRoot, ".next/server");
  const load = createRequire(path.join(server, "webpack-runtime.js"));
  await load(path.join(server, "app/api/chat/route.js"));
  const webpack = load(path.join(server, "webpack-runtime.js"));
  const candidates = Object.entries(webpack.m).filter(
    ([, factory]) =>
      factory.toString().includes("Missing Hermes API key") &&
      factory.toString().includes("/chat/stream"),
  );
  assert.equal(candidates.length, 1, "Deployed session-aware adapter must be present exactly once");
  const exports = await webpack(candidates[0][0]);
  const adapter = Object.values(exports).find(
    (value) => typeof value === "function" && value.constructor.name === "AsyncFunction",
  );
  assert(adapter, "Deployed chat adapter export not found");
  const config = { baseUrl, apiKey: process.env.HERMES_API_KEY, model: "hermes-agent" };
  const headers = { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" };
  const realFetch = globalThis.fetch;
  let sessionsUrl = null;
  // Observe the deployed adapter's actual profile route without mocking HTTP.
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (init?.method === "POST" && url.endsWith("/api/sessions")) {
      if (sessionsUrl) {
        assert.equal(url, sessionsUrl, "Active profile changed during verification");
      }
      sessionsUrl = url;
    }
    return realFetch(input, init);
  };

  async function turn(message) {
    const stream = await adapter({
      sessionKey: sessionId,
      message,
      userId: "synthetic-context-smoke",
      config,
    });
    const text = await new Response(stream).text();
    const events = text
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)));
    assert(!events.some((event) => event.type === "error"), "Adapter emitted an error");
    assert(
      events.some((event) => event.type === "finish"),
      "Adapter did not complete",
    );
    return events
      .filter((event) => event.type === "text-delta")
      .map((event) => event.delta)
      .join("")
      .trim();
  }

  try {
    const first = await turn(
      `This is a synthetic chat-continuity verification. Do not call tools, modify files, save memory, or send anything. Remember this marker only within this conversation: ${marker}. Reply exactly ACK.`,
    );
    assert.equal(first, "ACK");
    const second = await turn(
      "This is the second synthetic verification turn. Do not call tools. Reply with exactly the marker supplied in my previous message, with no other text.",
    );
    assert.equal(second, marker, "Follow-up lost the previous turn's marker");
    assert(sessionsUrl, "Adapter did not select a persisted-session route");
    const response = await fetch(`${sessionsUrl}/${encodeURIComponent(sessionId)}/messages`, {
      headers,
    });
    assert.equal(response.status, 200);
    const saved = await response.json();
    const serialized = JSON.stringify(saved);
    assert(serialized.includes(marker), "Marker missing from persisted transcript");
    assert(
      serialized.includes("second synthetic verification turn"),
      "Follow-up missing from persisted transcript",
    );
    console.log(
      JSON.stringify({
        sessionId,
        deployedAdapterModule: candidates[0][0],
        firstTurn: "ACK",
        secondTurnRecalledMarker: true,
        savedTranscriptVerified: true,
      }),
    );
  } finally {
    try {
      assert(sessionsUrl, "No session route available for cleanup");
      const response = await fetch(`${sessionsUrl}/${encodeURIComponent(sessionId)}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ archived: true, hidden: true }),
      });
      assert.equal(response.status, 200, "Could not archive synthetic verification session");
      const readback = await fetch(`${sessionsUrl}/${encodeURIComponent(sessionId)}`, { headers });
      assert.equal(readback.status, 200);
      const saved = await readback.json();
      const session = saved.session || saved;
      assert(session.archived && session.hidden, "Synthetic session archival not verified");
      console.log(JSON.stringify({ sessionId, archived: true, hidden: true }));
    } catch (error) {
      console.error("Cleanup failed:", error.message);
      process.exitCode = 1;
    } finally {
      globalThis.fetch = realFetch;
    }
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
