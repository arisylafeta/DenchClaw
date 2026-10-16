# Hermes gateway transport

The four TypeScript files are verbatim copies from `/usr/local/lib/hermes-agent/apps/shared/src`, pinned to installed version `0.21.5+7339.g683e845.dirty`, revision `683e845357d3b088faa5d60bd8030e0d075c5dcb`. The installed source tree was dirty; the files, not the revision alone, identify this snapshot. No shared barrel or additional modules are needed.

Import-path edits: none. The `.js` import specifiers resolve to TypeScript under the application's bundler resolution.

`lib/hermes-gateway/manager.ts` uses the transport-independent request channel with an injected Node `ws` socket factory. It owns connection recovery, heartbeat and session replay; it does not instantiate the browser-oriented gateway client.

`contract-drift.test.ts` compares RPC method names with the installed OpenRPC contract when available. Updating the vendor snapshot requires reviewing the installed source changes and updating the version notice. See LICENSE-NOTICE for the upstream MIT license.
