import "server-only";

import * as postmark from "postmark";
import { getPostmarkEnv } from "@/lib/platform-admin/env";

let _client: postmark.ServerClient | null = null;

/**
 * Returns a lazy singleton Postmark ServerClient.
 * Initialised on first call, reused across requests in the same process.
 */
export function getPostmarkClient(): postmark.ServerClient {
  if (!_client) {
    const env = getPostmarkEnv();
    _client = new postmark.ServerClient(env.postmarkServerToken);
  }
  return _client;
}
