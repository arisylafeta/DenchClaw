import "server-only";

// The one model step in a match run: it reads the five the scorer kept, may put them in a different order, and writes a
// one or two sentence reason for each from the facts given. It sees no names, contacts or addresses. Its answer is
// checked by checkRanking() before anything is stored; tests pass their own ranker.
import { askAgent, parseJson } from "../relay";

export type RankRequest = {
  side: "supply" | "demand";
  /** The deal's product in the key's words: what is being sourced or sold. */
  ask: string;
  candidates: { id: string; facts: string }[];
};

export type MatchRanker = {
  /** Recorded in scored_by with the prompt version, so a result can be traced to what produced it. */
  model: string;
  prompt: string;
  rank: (request: RankRequest) => Promise<unknown>;
};

export const MATCH_PROMPT_VERSION = "match-rank-2026-11-12";

const SYSTEM = `You rank candidates for one battery deal at ReBattery, a UK broker of used EV and storage batteries.
A deterministic scorer has already kept these candidates and put them in its order. You may reorder them when the facts
clearly favour a different order: an exact product match over a near one, a stated quantity that covers the need over an
unstated one, a stated price over none. Keep the scorer's order when unsure.
For each candidate write one or two plain sentences saying why it is where it is. Use only the facts given for that
candidate and the deal: never a figure, product, place or test that is not written there, and never a company or person
name. No em dashes. British English.
Return ONLY JSON: {"order": ["c1", ...every id once...], "reasons": {"c1": "...", ...}}`;

export const modelRanker: MatchRanker = {
  model: "hermes-agent",
  prompt: MATCH_PROMPT_VERSION,
  rank: async (request) => {
    const user = `${request.side === "demand" ? "The buyer is asking for" : "We are selling"}: ${request.ask}\n\n`
      + request.candidates.map((candidate) => `Candidate ${candidate.id}\n${candidate.facts}`).join("\n\n");
    return parseJson(await askAgent(SYSTEM, user, 90_000));
  },
};
