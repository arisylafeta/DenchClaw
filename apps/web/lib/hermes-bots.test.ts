import { describe, expect, it } from "vitest";
import { botConfig, botEntries, botName } from "./hermes-bots";

describe("hermes bots", () => {
	it("keeps Enricho as ordinary chats so New chat starts a fresh one", () => {
		expect(botConfig("enricho").mode).toBe("multi");
		expect(botName("enricho")).toBe("Enricho");
		expect(botEntries(["enricho", "sorcerer"], [], "user-1").map((entry) => entry.profile)).toEqual(["sorcerer"]);
	});

	it("still treats the single-session bots as one main session", () => {
		for (const profile of ["sorcerer", "papajules", "dismantlercampaigns", "auctions", "recyclops"]) {
			expect(botConfig(profile).mode).toBe("single");
		}
	});
});
