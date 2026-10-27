# PRD: Relay and bulk-trade offers

Status: draft for Alex, 27 Oct 2026. Relay is Alex's page. Nothing here is built, and nothing changes in Relay without his yes.

## Problem

An offer email, its reply and the next chase currently live in three places that do not talk to each other:

- Relay (`~crm/relay`) sorts Alex's Gmail threads into Action, Follow and Other, drafts replies and checks them.
- Trades Preview holds the listing and its offers (stage, terms, last touch, who the ball is with).
- The hourly offer-mail index (REB-572) logs each sent offer email and its replies on the offer.

Alex has to remember what was offered when he replies, and someone has to keep the offer record in step by hand.

## What exists today (facts)

- Relay links a thread to a bulk listing from the thread's links (confirmed or proposed), or from the counterpart's own listing. A buyer emailing about someone else's stock is linked to the buyer's own demand, never to that supply. A deal-linked thread chases after 4 working days, otherwise 7.
- Relay has no notion of an offer. Its drafts see the listing row only.
- The index writes a `proposed` thread link for each offer email it finds, and logs replies on the offer. Relay reads thread links, so it may pick these up. None of the 14 threads indexed so far is in Relay yet (the mail is old), so this path is untested end to end.
- A first attempt to put offer context into Relay's drafts shipped and was reverted the same day, because Relay is Alex's.

## Goal

When Alex answers a counterpart about a deal, Relay already knows what we offered them, and the offer record updates itself from what he sends and what they reply. Alex types nothing extra.

## Options (smallest first)

1. **Do nothing in Relay.** Rely on the proposed thread links. Cost: none. Gap: drafts still do not know the offer terms.
2. **Offer card on a Relay item (read only).** Show, for the item's deal and this counterpart only: stage, what was offered, their terms, last touch, who the ball is with. Gap closed: Alex sees the offer without leaving Relay.
3. **Offer context for drafting and the number check.** Give the drafting agent the same facts. The "before you send" check then treats the offer's own price as known. Rules: only this counterpart's offers; never another buyer's price; never the seller's name.
4. **Sends register themselves.** A send from a Relay item whose deal holds exactly one offer for that recipient is logged on that offer (touch, Story row, proposed thread link). Today only threads that already carry an offer link are logged.
5. **Stage nudge.** On a reply to an offer, Relay shows "reply received, propose stage move". A person decides; nothing moves automatically.

## Recommendation

Do 2 and 3 first (read only, no new writes in Relay), then 4. Keep 5 for later. Alex owns the design and the code. If he wants, the offer lookup is a small query on `crm_bulk_offers` (match by the item's listing and the counterpart's email), with no schema change.

## Out of scope

- Moving offer stages automatically. Stage moves stay with a person.
- Sending anything, or Discord alerts. Relay's Action and Follow tabs are where replies and chases are seen.
- WhatsApp (outbound is not captured yet).

## Privacy rules (non negotiable)

- A reply draft may use only the offers made to the person being answered.
- Seller identity, location and price are never given to a buyer.
- Facts a draft relies on must come from the thread, the deal or this counterpart's offer, as Relay already requires.

## Open questions for Alex

1. Which of options 2 to 5 do you want, and in what order?
2. Should the offer card sit on the Relay item or only inside the draft panel?
3. Do you want me to build it in your code, or will you build it and I supply the offer query?
4. Is the 4-day chase right for an offered deal, or should an offer with its own chase date use that?

## How we would know it works

- On three real deal threads, the draft names the right stage and terms and the number check raises no false alarm.
- A Relay send on a deal with one matching offer appears as one Story row and one index row, and a second run changes nothing.
- No draft ever shows another buyer's price or a seller's name (spot-checked on a supply with several offers).
- Browser checks run by a QA subagent against staging, not by the builder.
