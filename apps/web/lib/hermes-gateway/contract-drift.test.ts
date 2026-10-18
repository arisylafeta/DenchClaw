import { existsSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { RPC_METHODS } from "../../vendor/hermes-gateway/gateway-contract.generated";

const installedContract = "/usr/local/lib/hermes-agent/apps/shared/src/gateway-contract.openrpc.json";
it.skipIf(!existsSync(installedContract))("matches installed Hermes OpenRPC method names (skipped when Hermes is not installed)", () => {
  const contract = JSON.parse(readFileSync(installedContract, "utf8")) as { methods: { name: string }[] };
  expect([...RPC_METHODS].sort()).toEqual([...new Set(contract.methods.map(method => method.name))].sort());
});
