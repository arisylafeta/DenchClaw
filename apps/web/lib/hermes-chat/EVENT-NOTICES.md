# Gateway transcript notices

Catalog: `BackendGatewayEventMap` in the vendored generated contract. Emit references below are relative to `/usr/local/lib/hermes-agent/tui_gateway`. References include dispatch sites for dynamically named emits.

Local notices last for the mounted session, survive history resync, and yield to equivalent persisted notices. Status coalesces by kind, resume hydration by session, connections by operation. Subagent lifecycle remains exclusively in the dock. Billing never copies device codes or URLs into history. Reactions and tips deliberately do not create notices.

| Event | Decision | Reason | Backend reference |
| --- | --- | --- | --- |
| agent.terminal.output | Ignore | Raw terminal chunks are not completion notices; persisted background-process rows own conversation-relevant results. | session_notifications.py:816 |
| approval.cancelled | Notice | Session-visible update; repeated status and progress coalesce. | session_lifecycle.py:505 |
| background.complete | Notice | Session-visible update; repeated status and progress coalesce. | methods_prompt.py:1060 |
| billing.step_up.verification | Notice | Session-visible update; repeated status and progress coalesce. | methods_session.py:1949 |
| bot_relay.outbox.pending | Ignore | Separate desktop surface, refetch signal or non-conversational metadata. | change_watcher.py:296 |
| browser.controller.cancel | Ignore | Separate desktop surface, refetch signal or non-conversational metadata. | Contract only; no literal emit site |
| browser.controller.command | Ignore | Separate desktop surface, refetch signal or non-conversational metadata. | Contract only; no literal emit site |
| browser.progress | Ignore | Separate desktop surface, refetch signal or non-conversational metadata. | methods_browser.py:111 |
| btw.complete | Notice | Session-visible update; repeated status and progress coalesce. | methods_prompt.py:1082 |
| connection.request | Notice | Session-visible update; repeated status and progress coalesce. | agent_callbacks.py:176 |
| connection.update | Notice | Session-visible update; repeated status and progress coalesce. | methods_connectors.py:412 |
| cron.changed | Ignore | Separate desktop surface, refetch signal or non-conversational metadata. | change_watcher.py:287 |
| display.install.done | Ignore | Separate desktop surface, refetch signal or non-conversational metadata. | methods_display.py:223 |
| display.install.log | Ignore | Separate desktop surface, refetch signal or non-conversational metadata. | methods_display.py:209 |
| display.lease | Ignore | Separate desktop surface, refetch signal or non-conversational metadata. | methods_display_watch.py:147, methods_display.py:45 |
| display.status | Ignore | Separate desktop surface, refetch signal or non-conversational metadata. | methods_display_watch.py:102, methods_display.py:50 |
| error | Notice outside turn | During a turn, existing assistant error surface owns it. | methods_prompt.py:616, host_supervisor.py:411 |
| gateway.ready | Ignore | Separate desktop surface, refetch signal or non-conversational metadata. | ws.py:367, entry.py:313 |
| layout.apply | Ignore | Separate desktop surface, refetch signal or non-conversational metadata. | Contract only; no literal emit site |
| message.complete | Already handled | Transcript, usage state, todos or subagent dock owns it; avoid duplication. | compute_host_bridge.py:258, session_auto_continue.py:581 |
| message.delta | Already handled | Transcript, usage state, todos or subagent dock owns it; avoid duplication. | hosted_room_member_activity.py:26, agent_callbacks.py:28 |
| message.interim | Already handled | Transcript, usage state, todos or subagent dock owns it; avoid duplication. | hosted_room_member_activity.py:27, agent_callbacks.py:184 |
| message.reaction | Ignore | Reaction decoration, not a system event; do not add transcript noise. | Contract only; no literal emit site |
| message.start | Already handled | Transcript, usage state, todos or subagent dock owns it; avoid duplication. | session_auto_continue.py:127, agent_callbacks.py:62 |
| moa.aggregating | Ignore | Separate desktop surface, refetch signal or non-conversational metadata. | tool_progress.py:487 |
| moa.phase | Ignore | Separate desktop surface, refetch signal or non-conversational metadata. | tool_progress.py:420 |
| moa.progress | Ignore | Separate desktop surface, refetch signal or non-conversational metadata. | tool_progress.py:406 |
| moa.reference | Ignore | Separate desktop surface, refetch signal or non-conversational metadata. | tool_progress.py:398 |
| notice | Notice | Session-visible update; repeated status and progress coalesce. | model_switch.py:432, methods_tools.py:715 |
| notification.clear | Ignore | Separate desktop surface, refetch signal or non-conversational metadata. | server.py:993, agent_callbacks.py:164 |
| notification.show | Ignore | Separate desktop surface, refetch signal or non-conversational metadata. | server.py:988, agent_callbacks.py:130 |
| pairing.changed | Ignore | Separate desktop surface, refetch signal or non-conversational metadata. | change_watcher.py:294 |
| pane.reveal | Ignore | Separate desktop surface, refetch signal or non-conversational metadata. | Contract only; no literal emit site |
| pet.changed | Ignore | Separate desktop surface, refetch signal or non-conversational metadata. | change_watcher.py:286 |
| pet.generate.progress | Ignore | Separate desktop surface, refetch signal or non-conversational metadata. | methods_session.py:1764 |
| pet.hatch.progress | Ignore | Separate desktop surface, refetch signal or non-conversational metadata. | methods_session.py:1818 |
| platforms.changed | Ignore | Separate desktop surface, refetch signal or non-conversational metadata. | change_watcher.py:292 |
| preview.close | Ignore | Separate desktop surface, refetch signal or non-conversational metadata. | Contract only; no literal emit site |
| preview.open | Ignore | Separate desktop surface, refetch signal or non-conversational metadata. | Contract only; no literal emit site |
| preview.restart.complete | Ignore | Separate desktop surface, refetch signal or non-conversational metadata. | methods_prompt.py:1141 |
| preview.restart.progress | Ignore | Separate desktop surface, refetch signal or non-conversational metadata. | methods_prompt.py:1123, agent_callbacks.py:494 |
| projects.changed | Ignore | Separate desktop surface, refetch signal or non-conversational metadata. | change_watcher.py:293 |
| reaction | Ignore | Reaction decoration, not a system event; do not add transcript noise. | agent_callbacks.py:159 |
| reasoning.available | Already handled | Transcript, usage state, todos or subagent dock owns it; avoid duplication. | tool_progress.py:386 |
| reasoning.delta | Already handled | Transcript, usage state, todos or subagent dock owns it; avoid duplication. | hosted_room_member_activity.py:28, agent_callbacks.py:28 |
| request.cancel | Notice | Session-visible update; repeated status and progress coalesce. | compute_host_bridge.py:152, server_requests.py:146 |
| review.summary | Notice | Session-visible update; repeated status and progress coalesce. | server.py:1053 |
| session.control.update | Notice | Session-visible update; repeated status and progress coalesce. | methods_session_control.py:229 |
| session.info | Notice on change | Only changed model, branch and cwd; initial snapshot is silent. | methods_prompt.py:624, methods_session.py:1100 |
| session.reclaimed | Notice | Session-visible update; repeated status and progress coalesce. | session_lifecycle.py:475 |
| session.resume_progress | Notice | Session-visible update; repeated status and progress coalesce. | server.py:2977 |
| session.title | Notice | Session-visible update; repeated status and progress coalesce. | methods_session.py:1220, prompt_turn.py:797 |
| session.usage | Already handled | Transcript, usage state, todos or subagent dock owns it; avoid duplication. | methods_session.py:1449, server.py:178 |
| sessions.changed | Ignore | Separate desktop surface, refetch signal or non-conversational metadata. | change_watcher.py:288 |
| setup.ready | Ignore | Separate desktop surface, refetch signal or non-conversational metadata. | Contract only; no literal emit site |
| skin.changed | Ignore | Separate desktop surface, refetch signal or non-conversational metadata. | change_watcher.py:86, methods_config_set.py:458 |
| status.update | Notice | Session-visible update; repeated status and progress coalesce. | server.py:858, session_auto_continue.py:126 |
| subagent.complete | Already handled | Transcript, usage state, todos or subagent dock owns it; avoid duplication. | agent_callbacks.py:44 |
| subagent.progress | Already handled | Transcript, usage state, todos or subagent dock owns it; avoid duplication. | Contract only; no literal emit site |
| subagent.spawn_requested | Already handled | Transcript, usage state, todos or subagent dock owns it; avoid duplication. | Contract only; no literal emit site |
| subagent.start | Already handled | Transcript, usage state, todos or subagent dock owns it; avoid duplication. | agent_callbacks.py:29 |
| subagent.thinking | Already handled | Transcript, usage state, todos or subagent dock owns it; avoid duplication. | agent_callbacks.py:28, tool_progress.py:463 |
| subagent.tool | Already handled | Transcript, usage state, todos or subagent dock owns it; avoid duplication. | agent_callbacks.py:71, tool_progress.py:465 |
| terminal.close | Ignore | Separate desktop surface, refetch signal or non-conversational metadata. | session_notifications.py:818 |
| thinking.delta | Already handled | Transcript, usage state, todos or subagent dock owns it; avoid duplication. | agent_callbacks.py:123, ws.py:82 |
| tip.show | Ignore | Separate desktop surface, refetch signal or non-conversational metadata. | Contract only; no literal emit site |
| todo.updated | Already handled | Transcript, usage state, todos or subagent dock owns it; avoid duplication. | tool_progress.py:366 |
| tool.complete | Already handled | Transcript, usage state, todos or subagent dock owns it; avoid duplication. | hosted_room_member_activity.py:24, agent_callbacks.py:77 |
| tool.generating | Already handled | Transcript, usage state, todos or subagent dock owns it; avoid duplication. | agent_callbacks.py:156 |
| tool.output_risk | Notice | Session-visible update; repeated status and progress coalesce. | hosted_room_member_activity.py:25, tool_progress.py:377 |
| tool.start | Already handled | Transcript, usage state, todos or subagent dock owns it; avoid duplication. | hosted_room_member_activity.py:23, agent_callbacks.py:88 |
| voice.interrupted | Ignore | Separate desktop surface, refetch signal or non-conversational metadata. | methods_voice.py:246 |
| voice.status | Ignore | Separate desktop surface, refetch signal or non-conversational metadata. | methods_voice.py:709 |
| voice.transcript | Ignore | Separate desktop surface, refetch signal or non-conversational metadata. | methods_prompt.py:255, methods_voice.py:259 |
| wake.detected | Ignore | Separate desktop surface, refetch signal or non-conversational metadata. | methods_voice.py:426 |
