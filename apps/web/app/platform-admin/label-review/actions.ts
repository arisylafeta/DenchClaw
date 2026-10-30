"use server";

import { unstable_noStore as noStore } from "next/cache";
import { currentUser } from "@/lib/auth";
import {
  correctionInstruction,
  decisionObservation,
  validateDecision,
  validateGroupDecision,
  type LabelDecisionInput,
  type LabelGroupDecisionInput,
  type LabelReviewPage,
} from "./contract";
import { currentItemVersion, readEntry, readLabelQueue, stockCli } from "./stock-source";

export type DecisionResult = { ok: true; observationId: string } | { ok: false; error: string };

async function signedIn() {
  const user = await currentUser();
  if (!user) throw new Error("Sign in to review labels.");
  return user;
}

/** The queue of label photos with the engine's reading beside the stored value. */
export async function getLabelReviewPage(): Promise<LabelReviewPage> {
  noStore();
  await signedIn();
  return readLabelQueue();
}

/**
 * Records one decision. Approve and reject append an observation to the row. Correct first sets the
 * pack energy as an owner-directed value (authority user_directed, your note as the instruction) and
 * then appends the observation. History is never edited, and nothing is delivered from here.
 */
export async function recordLabelDecision(raw: LabelDecisionInput): Promise<DecisionResult> {
  noStore();
  let user;
  try {
    user = await signedIn();
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Not signed in." };
  }
  const checked = validateDecision(raw);
  if (!checked.ok) return checked;
  const input = checked.value;
  const entry = await readEntry(input.observationId);
  if (!entry) return { ok: false, error: "That label photo is no longer in the queue." };
  if (entry.decision) return { ok: false, error: `Already ${entry.decision.decision}d by ${entry.decision.by}.` };
  const by = `crm:${user.email}`;
  try {
    if (input.decision === "correct") {
      await stockCli(["user-update", entry.itemId], {
        rows: [{
          itemId: entry.itemId,
          expectedVersion: await currentItemVersion(entry.itemId),
          instruction: correctionInstruction(entry, input, by),
          changes: { "listingData.packKwh": { set: input.correctedKwh } },
        }],
      }, by);
    }
    await stockCli(["observe", entry.itemId], decisionObservation(entry, input, by), by);
    return { ok: true, observationId: entry.observationId };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message.split("\n")[0] : "The stock command failed." };
  }
}

export type GroupDecisionResult = { ok: true; done: number; skipped: number } | { ok: false; error: string; done: number };

/**
 * Applies one decision to every pending reading of a part-code group. A correction sets the pack energy once per row
 * (owner-directed), then each reading gets its own decision observation, so each stays checked on its own.
 */
export async function recordLabelGroupDecision(raw: LabelGroupDecisionInput): Promise<GroupDecisionResult> {
  noStore();
  let user;
  try {
    user = await signedIn();
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Not signed in.", done: 0 };
  }
  const checked = validateGroupDecision(raw);
  if (!checked.ok) return { ok: false, error: checked.error, done: 0 };
  const input = checked.value;
  const queue = (await readLabelQueue()).entries;
  const wanted = new Set(input.observationIds);
  const entries = queue.filter((e) => wanted.has(e.observationId) && !e.decision);
  const skipped = input.observationIds.length - entries.length;
  if (entries.length === 0) return { ok: false, error: "Nothing left to check in that group.", done: 0 };
  const by = `crm:${user.email}`;
  let done = 0;
  const corrected = new Set<string>();
  try {
    for (const entry of entries) {
      const single: LabelDecisionInput = { observationId: entry.observationId, decision: input.decision, note: input.note, correctedKwh: input.correctedKwh };
      if (input.decision === "correct" && !corrected.has(entry.itemId)) {
        await stockCli(["user-update", entry.itemId], {
          rows: [{
            itemId: entry.itemId,
            expectedVersion: await currentItemVersion(entry.itemId),
            instruction: correctionInstruction(entry, single, by),
            changes: { "listingData.packKwh": { set: input.correctedKwh } },
          }],
        }, by);
        corrected.add(entry.itemId);
      }
      await stockCli(["observe", entry.itemId], decisionObservation(entry, single, by), by);
      done += 1;
    }
    return { ok: true, done, skipped };
  } catch (error) {
    return { ok: false, error: `${error instanceof Error ? error.message.split("\n")[0] : "The stock command failed."} (${done} of ${entries.length} saved)`, done };
  }
}
