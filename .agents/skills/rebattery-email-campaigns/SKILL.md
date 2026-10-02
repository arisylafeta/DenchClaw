---
name: rebattery-email-campaigns
description: Prepare, freeze, launch, or reconcile a ReBattery Postmark campaign from Dench CRM with the maintained rebattery-campaign CLI. Use for CRM-list or SQL-selected cohorts and per-person auction pitch tracking; not for one-to-one founder Gmail replies.
---

# ReBattery Email Campaigns

Run `python3 scripts/rebattery/rebattery-campaign.py --help` from the committed DenchClaw checkout containing this skill, not a different or stale development checkout. This skill operates the CLI; it is not a substitute for campaign, sender, schema, provider-configuration, or send approval. Read the nearest project instructions and the `writing-emails` skill for creative.

Load `POSTMARK_SERVER_TOKEN` through the approved private runtime secret source before provider checks or sending; never print the token or put it in a manifest. The web service's environment is not automatically inherited by a CLI shell. The default database is local `denchclaw`; `DENCH_CAMPAIGN_DSN` overrides it and must be verified before use.

## Prepare

Create a local JSON manifest with a stable `id`, `name`, `objective`, `success_measure`, primary `listing_id` and public `auction_url`, `stock_snapshot_ref`, `message_version`, `sender`, `reply_to`, `reply_owner`, `subject`, `html`, `text`, and Broadcast `stream`. Include `links`, an ordered array of `{ "key": "tesla", "url": "https://...", "listing_id": "..." }`. Use `listing_id` only for lot CTAs; the grid and sourcing-form CTAs omit it. Every outgoing anchor and plain-text URL must appear exactly once in `links` and both bodies. A three-lot supply update needs five entries: three lots, the grid and the sourcing form. The HTML and text must both include Postmark's `{{{ pm:unsubscribe }}}` placeholder. Select contacts with **either** `person_ids` (exact CRM IDs) **or** `cohort_sql` (path to a single SELECT returning only `person_id`). A query selects candidates; the frozen cohort records the resolved CRM person, company and email, so future tag/query changes cannot alter a run. Do not commit live recipient manifests or personal data.

A SQL cohort file can be as small as `select id as person_id from crm_people where ... order by id`. The CLI runs it in a read-only transaction, enforces 1–500 distinct IDs, rejects missing/opted-out addresses and duplicate emails, and then freezes resolved identities. Query criteria still need human review for relevance and verified email routes.

1. Confirm every auction/listing identity, current stock and claims, sender signature, Broadcast stream/unsubscribe behavior, reply mailbox and owner, and the recipient-address evidence. Check CRM opt-outs, provider suppressions, stale contacts and previous pitches before approval. The CLI currently rejects CRM opt-outs and duplicate addresses; it does **not** replace the remaining human checks.
2. Run `preview --manifest <path>`. Inspect all recipients and prior pitch counts. If any identity or suppression is uncertain, stop.
3. `freeze --manifest <path> --apply` needs an approved database migration/write and captures the exact cohort. Freeze emits a SHA-256 digest of creative, routing, tracking options and resolved cohort in canonical recipient-email order, independent of database collation. A dry run omits `--apply`.
4. Show Ari the complete manifest, recipient list and digest. Only after explicit approval of those exact inputs, run `approve --campaign-id <id> --sha256 <digest> --approved-by <name> --apply`. Approval is a record of a human decision, not permission the CLI may invent.

## Launch and reconcile

`launch --manifest <path> --approved-sha256 <digest> --apply` also requires `DENCH_CAMPAIGN_LIVE_SEND=1` and **separate approval for the actual send**. It sends one address per Postmark request. Postmark rewrites each link per recipient; its message ID and the exact destination map the click to the frozen person and CTA in `crm_campaign_send_links`. The CLI claims a frozen row before calling Postmark. If a response is lost, that row becomes `unknown`; stop and reconcile it against Postmark before any further attempt. Never reset `sending` or `unknown` and retry blindly. A changed manifest fails the digest check.

Before launching, inspect this campaign's send states in `crm_campaign_sends`. If any row is `sending` or `unknown`, stop and recover/reconcile it first. Never run concurrent launches or rerun a launch to send the remaining frozen rows while an uncertain receipt remains. The CLI's per-recipient claim prevents duplicate claims, but does not enforce a campaign-wide reconciliation stop.

`recover --manifest <path>` looks up uncertain sends by exact Postmark metadata without sending; `--apply` links one unambiguous provider receipt. A zero-match result remains unresolved and is not permission to resend. `sync --campaign-id <id>` reads provider message details without CRM writes; `--apply` writes delivery, bounce and first observed open/click timestamps per send **and per CTA**. Repeat readback on send day and D+1/D+3/D+7 while the reply owner checks the authoritative inbox, handles opt-outs and records human interest and next actions. Provider opens are noisy and a link click is not proof of a site visit. Report sent, delivered, clicked, replied and qualified separately; count pitches from accepted sends for each person/listing. Close with a recorded review before repeating a campaign.

## Boundaries

- Code/migration files are not permission to apply a production schema, backfill September, change Postmark configuration, deploy or restart a service. Back up and obtain the applicable explicit approval first.
- Do not use the old `Supply Update` tag as a sent cohort, the existing Gmail message table as a Postmark receipt, or Gmail 1:1 as a campaign channel.
- The current CLI does not implement provider webhooks, site-visit attribution, automatic replies, or trade attachment. Check those separately instead of reporting them as measured outcomes.
