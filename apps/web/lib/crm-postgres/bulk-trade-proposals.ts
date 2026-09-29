import { queryPg, withPgTransaction } from "../postgres";
import type { CheckStatus, FileType, Proposal } from "../bulk-trade-details";
import { FILE_TYPES } from "../bulk-trade-details";
import { fetchGmailAttachment } from "../gmail-drafts";
import { createBulkTrade, updateBulkTrade } from "./bulk-trades";
import { addBuyer, addContact, recordFile, setField, updateBuyer } from "./bulk-trade-details";

const PROPOSAL_SELECT = `
  select id::text as id, lot_id, kind, target, proposed, summary, quote, source_kind, source_url, source_label,
    source_at, created_at
  from crm_bulk_trade_proposals`;

/** Open proposals for one trade, including threads flagged because they touch it and others. */
export async function tradeProposals(lotId: string): Promise<Proposal[]> {
  return queryPg<Proposal>(
    `${PROPOSAL_SELECT}
     where status = 'new' and (lot_id = $1 or (kind = 'needs_triage' and proposed->'lot_ids' ? $1))
     order by created_at, id`,
    [lotId],
  );
}

/** Open "possible new trade" proposals, newest first. */
export async function possibleTrades(): Promise<Proposal[]> {
  return queryPg<Proposal>(`${PROPOSAL_SELECT} where status = 'new' and kind = 'possible_trade' order by created_at desc limit 20`);
}

export async function checkStatus(): Promise<CheckStatus> {
  const [row] = await queryPg<{ last_run_at: string; status: "running" | "ok" | "failed"; error: string | null }>(
    `select coalesce(finished_at, started_at) as last_run_at, status, error
     from crm_bulk_trade_check_runs order by started_at desc limit 1`,
  );
  return row ?? null;
}

export type Decision = { ok: true; lot_id: string | null } | { ok: false; status: number; error: string };

const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
const date = (value: unknown) => (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null);

/**
 * Accepts or ignores a proposal. Accepting applies it through the same functions the app uses for
 * a manual edit, so it is validated and logged like one. The proposal is claimed first, so two
 * clicks never apply it twice; if applying fails, it goes back to "new".
 */
export async function decideProposal(
  id: string,
  action: "accept" | "ignore",
  user: { id: string; email: string },
): Promise<Decision> {
  const claimed = await withPgTransaction(async (client) => {
    const { rows } = await client.query(
      `update crm_bulk_trade_proposals set status = $2, decided_at = now(), decided_by = $3
       where id = $1 and status = 'new'
       returning id::text as id, lot_id, kind, target, proposed, summary, quote, source_kind, source_url,
         source_label, to_char(source_at, 'YYYY-MM-DD') as source_date`,
      [id, action === "accept" ? "accepted" : "ignored", user.id],
    );
    const proposal = rows[0] as (Proposal & { source_date: string | null }) | undefined;
    if (proposal?.lot_id) {
      await client.query(
        `insert into crm_bulk_trade_events (lot_id, kind, changes, actor_user_id) values ($1, $2, $3, $4)`,
        [proposal.lot_id, action === "accept" ? "proposal_accepted" : "proposal_ignored",
          JSON.stringify({ proposal_id: proposal.id, kind: proposal.kind, summary: proposal.summary }), user.id],
      );
    }
    return proposal ?? null;
  });
  if (!claimed) return { ok: false, status: 404, error: "Already handled or not found." };
  if (action === "ignore") return { ok: true, lot_id: claimed.lot_id };

  try {
    const lotId = await apply(claimed, user);
    return { ok: true, lot_id: lotId };
  } catch (err) {
    await queryPg(
      "update crm_bulk_trade_proposals set status = 'new', decided_at = null, decided_by = null where id = $1",
      [id],
    );
    return { ok: false, status: 422, error: err instanceof Error ? err.message : "Could not apply this proposal." };
  }
}

async function apply(p: Proposal & { source_date: string | null }, user: { id: string; email: string }): Promise<string | null> {
  const proposed = p.proposed;
  const lotId = p.lot_id;
  switch (p.kind) {
    case "field": {
      const status = proposed.status === "confirmed" ? "confirmed" : "unverified";
      const result = await setField(lotId!, p.target!, {
        value: text(proposed.value) ?? undefined, status,
        source_label: p.source_label, source_url: p.source_url, source_date: p.source_date,
      }, user.id);
      if (!result || result === "unknown_field") throw new Error("That field no longer applies to this trade.");
      return lotId;
    }
    case "buyer_update": {
      const input: Record<string, string> = {};
      if (text(proposed.status)) input.status = proposed.status as string;
      if (date(proposed.last_touch_on)) input.last_touch_on = proposed.last_touch_on as string;
      if (text(proposed.last_touch_via)) input.last_touch_via = proposed.last_touch_via as string;
      if (date(proposed.chase_on)) input.chase_on = proposed.chase_on as string;
      if (!(await updateBuyer(lotId!, p.target!, input, user.id))) throw new Error("That buyer is no longer on this trade.");
      return lotId;
    }
    case "next_step": {
      await updateBulkTrade(lotId!, {
        next_step: text(proposed.next_step),
        next_step_due: date(proposed.next_step_due),
        waiting_on: proposed.waiting_on === "them" ? "them" : "us",
      }, user.id);
      return lotId;
    }
    case "new_buyer": {
      const name = text(proposed.name);
      if (!name) throw new Error("The proposed buyer has no name.");
      await addBuyer(lotId!, { name, contact: text(proposed.contact), wants: text(proposed.wants) }, user.id);
      return lotId;
    }
    case "file": {
      const fileName = text(proposed.file_name);
      const messageId = text(proposed.gmail_message_id);
      if (!fileName || !messageId) throw new Error("The attachment reference is incomplete.");
      const content = await fetchGmailAttachment(user.email, messageId, fileName, text(proposed.attachment_id));
      const fileType = (FILE_TYPES as readonly string[]).includes(String(proposed.file_type)) ? proposed.file_type as FileType : "Other";
      await recordFile(lotId!, { file_name: fileName, file_type: fileType, content_type: null, content },
        { file_type: fileType, visibility: "never", source_label: p.source_label, source_date: p.source_date }, user.id);
      return lotId;
    }
    case "possible_trade": {
      const title = text(proposed.title);
      if (!title) throw new Error("The proposed trade has no title.");
      const trade = await createBulkTrade({
        title,
        trade_kind: ["packs", "cells", "systems", "recycling"].includes(String(proposed.trade_kind))
          ? proposed.trade_kind as "packs" : null,
        next_step: "Qualify this lead",
      }, user.id);
      return trade.id;
    }
    case "link_contact": {
      const email = text(proposed.email);
      if (!email) throw new Error("The proposed contact has no email.");
      await addContact(lotId!, { name: text(proposed.name) ?? email, email }, user.id);
      return lotId;
    }
    case "needs_triage":
      return lotId; // Acknowledged; Alex handles the thread by hand.
  }
}
