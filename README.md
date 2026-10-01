<p align="center">
  <a href="https://denchclaw.com">
    <img src="assets/denchclaw-hero.png" alt="DenchClaw — AI CRM, hosted locally on your Mac. Built on OpenClaw." width="680" />
  </a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/denchclaw"><img src="https://img.shields.io/npm/v/denchclaw?style=for-the-badge&color=000" alt="npm version"></a>&nbsp;
  <a href="https://discord.gg/PDFXNVQj9n"><img src="https://img.shields.io/discord/1456350064065904867?label=Discord&logo=discord&logoColor=white&color=5865F2&style=for-the-badge" alt="Discord"></a>&nbsp;
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
</p>

<p align="center">
  <a href="https://denchclaw.com">Website</a> · <a href="https://discord.gg/PDFXNVQj9n">Discord</a> · <a href="https://skills.sh">Skills Store</a> · <a href="https://www.youtube.com/watch?v=pfACTbc3Bh4&t=44s">Demo Video</a>
</p>

<br />

<p align="center">
  <a href="https://denchclaw.com">
    <img src="assets/denchclaw-app.png" alt="DenchClaw Web UI — workspace, object tables, and AI chat" width="780" />
  </a>
  <br />
  <a href="https://www.youtube.com/watch?v=pfACTbc3Bh4&t=44s">Demo Video</a> · <a href="https://discord.gg/PDFXNVQj9n">Join our Discord Server</a>
</p>

<br />

## Install

### Are you an AI agent reading this? In that case, use the prompt below to setup DenchClaw.

```
Install DenchClaw (an OpenClaw CRM Framwork) by running "npx denchclaw", when it asks to update OpenClaw, update it as DenchClaw requires up to date OpenClaw. When it asks for my Dench API Key, help me fetch it from dench.com/api and set it up. Remember that DenchClaw creates a new OpenClaw Gateway (~/.openclaw-dench) on port 19001 by default, and a new main agent in that gateway working in ~/.openclaw-dench/workspace directory (Separate from the usual non-DenchClaw OpenClaw gateway that usually sits in ~/.openclaw). All DenchClaw config sits in ~/.openclaw-dench/openclaw.json. Remember that anytime you interface with DenchClaw using openclaw commands, you must use "openclaw --profile dench" as a prefix, for example, to restart gateway, run "openclaw --profile dench gateway restart". After everything is setup, DenchClaw will be accessible at localhost:3100 by default. If for some reason that Port 19001 and 3100 or those ranges are taken, make sure to kill those ports/processes and then retry npx denchclaw. Also, sometimes if the Web UI on port 3100 crashes, just run "npx denchclaw update" to boot it back up. Remember to refer to https://github.com/DenchHQ/DenchClaw (DenchClaw's official GitHub Repository) for more information.
```

### Manual Install

**Node 22+ required.**

```bash
npx denchclaw@latest
```

Opens at `localhost:3100` after completing onboarding wizard.

---

## Commands

```bash
npx denchclaw@latest # runs onboarding again for openclaw --profile dench
npx denchclaw@latest update # updates denchclaw web-runtime with current settings as is
npx denchclaw restart # restarts denchclaw web server
npx denchclaw start # starts denchclaw web server
npx denchclaw stop # stops denchclaw web server

# some examples
openclaw --profile dench <any openclaw command>
openclaw --profile dench gateway restart

openclaw --profile dench config set gateway.port 19001
openclaw --profile dench gateway install --force --port 19001
openclaw --profile dench gateway restart
openclaw --profile dench uninstall
```

### Daemonless / Docker

For containers or environments without systemd/launchd, set the environment variable once:

```bash
export DENCHCLAW_DAEMONLESS=1
```

This skips all gateway daemon management (install/start/stop/restart) and launchd LaunchAgent installation across all commands. You must start the gateway yourself as a foreground process:

```bash
openclaw --profile dench gateway --port 19001
```

Alternatively, pass `--skip-daemon-install` to individual commands:

```bash
npx denchclaw --skip-daemon-install
npx denchclaw update --skip-daemon-install
npx denchclaw start --skip-daemon-install
```

---

## Campaign engagement

Open the campaign list at `/?path=campaign` or from **Campaigns** in the sidebar.
Campaigns use Dismantlers' compact rows, square controls and palette. The list's
search sits directly on the page body; its table is full width without an
enclosing card.
The dedicated page works even when campaigns are hidden from the workspace tree.
Open `/?path=campaign&entry=campaign:<id>` for a campaign's full detail page.
**Recipients** is the default tab: search by person, company, email or clicked
listing, then filter by observed opens, clicks, bounces or pending tracking.
Recipient names open their People profiles. **Listings** uses compact count
links instead of stacked names. Email clicks, browser activity and recorded
submissions open square right-side sheets, filtered by destination and source.
Each sheet has a searchable people table, 25 records per page, activity
timestamps and ordinary People links. Submission timestamps match the selected
action type. Listing links use canonical marketplace destinations, never
recipient tracking redirects. Technical metadata and notes are collapsed under
**Details**.

The sheets show observed redirect-click counts, last click and last view instead
of first-click/first-view timestamps. These counts and latest times come from
PostHog, not the historical Postmark snapshot. Unmapped or unavailable evidence
stays unknown. Tracked-click count links include all retained records with
observed redirects, separately from the email-clicked cohort.

Historical campaign snapshots remain separate from the retained recipient ledger:
the original sent count can exceed the number of recipient records still present.
`dench-campaign` totals use the existing ledger. Unknown tracking remains unknown,
and the latest recipient check does not imply that every recipient was checked.
The list and detail are read-only; they do not send messages or capture new events.

Registered CRM People tables use the same compact square presentation without
changing saved views, editing or table interactions. Company tables and custom
objects named People retain their existing presentation. Person profiles use
readable contact sections and compact campaign/destination tables. Listing
titles and safe public links come from the existing local auction cache; raw
identifiers and sync diagnostics stay under Details. Historical email first
observations remain first observations, not inferred latest website activity.

Website evidence is a separate read-only PostHog view. It shows page events,
distinct browser sessions and recorded offer, message and buy-now submissions
for assigned campaign links; general destinations remain separate from listings.
The observed source time and bounded campaign period are shown explicitly.
Missing attribution or unavailable evidence is **unknown**, not zero, and does
not block the email ledger. Forwarded links do not verify the named recipient,
and missing consented browser events do not prove inactivity. Email and website
snapshots are not a conversion rate or a human/bot classification.

In PostgreSQL-backed workspaces, a person's **Campaigns** tab shows lifetime
accepted-send, delivery, tracked-open and tracked-click totals, listing clicks
across updates, and each update's CTA activity. Counts use existing
`crm_campaign_sends` and `crm_campaign_send_links` records; multiple links in one
email do not multiply the send count, and multiple CTAs for one listing count
once per update. General CTAs are not listing engagement.

Counts measure emails with observed activity, not repeated opens/clicks or
verified human visits. Unsynced sends show pending tracking; each synced update
shows its last sync time. Email clicks do not establish site visits. This view
does not add interaction rows or change relationship scores. The campaign
`sync --campaign-id <id> --apply` command remains the existing data-refresh path.

## Troubleshooting

### `pairing required`

If the Control UI or CLI shows `gateway connect failed: GatewayClientRequestError: pairing required`, the local device is still waiting for approval.

Recent `denchclaw` bootstrap runs try to approve this automatically. If you are on an older install, or bootstrap skipped approval because there were multiple pending requests, list the pending devices first:

```bash
openclaw --profile dench devices list
```

Review the pending `operator` request, then approve it:

```bash
openclaw --profile dench devices approve --latest

# or approve the exact request you just reviewed
openclaw --profile dench devices approve <requestId>
```

If the client retries pairing, OpenClaw can replace the pending request with a new `requestId`, so run `devices list` immediately before approving. See the [OpenClaw devices docs](https://docs.openclaw.ai/cli/devices#openclaw-devices-list) for more details.

After approval, refresh the browser. If the UI is still disconnected, restart the managed web runtime:

```bash
npx denchclaw restart
```

---

## Development

```bash
git clone https://github.com/DenchHQ/DenchClaw.git
cd denchclaw

pnpm install
pnpm build

pnpm dev
```

Web UI development:

```bash
pnpm install
pnpm web:dev
```

---

## Open Source

MIT Licensed. Fork it, extend it, make it yours.

<p align="center">
  <a href="https://star-history.com/?repos=DenchHQ%2FDenchClaw&type=date&legend=top-left">
    <img src="https://api.star-history.com/image?repos=DenchHQ/DenchClaw&type=date&legend=top-left" alt="Star History" width="620" />
  </a>
</p>

<p align="center">
  <a href="https://github.com/DenchHQ/DenchClaw"><img src="https://img.shields.io/github/stars/DenchHQ/DenchClaw?style=for-the-badge" alt="GitHub stars"></a>
</p>
