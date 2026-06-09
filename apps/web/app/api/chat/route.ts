import type { UIMessage } from "ai";
import {
	resolveActiveAgentId,
	resolveAgentWorkspacePrefix,
	resolveOpenClawStateDir,
} from "@/lib/workspace";
import {
	startRun,
	startSubscribeRun,
	hasActiveRun,
	getActiveRun,
	subscribeToRun,
	persistUserMessage,
	persistAssistantMessage,
	persistSubscribeUserMessage,
	reactivateSubscribeRun,
	type SseEvent,
} from "@/lib/active-runs";
import { trackServer } from "@/lib/telemetry";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	getSessionMeta,
	hasRotatedGatewayThread,
	rotateGatewaySessionThreadForModelReset,
} from "@/app/api/web-sessions/shared";
import { getAgentSession } from "@/app/api/sessions/shared";
import {
	classifyOpenAiModelSwitch,
	isLikelyOpenAiModelId,
	needsOpenAiSwitchAcknowledgement,
} from "@/lib/chat-models";
import {
	buildChatImageHydrationErrorMessage,
	hydrateMessageImageAttachments,
} from "@/lib/chat-image-attachments";
import { resolveAgentBackend, resolveHermesConfig } from "@/lib/agent-backend";
import { createHermesChatStream } from "@/lib/hermes-client";
import {
	buildAgentMessage,
	type WorkspaceContext,
} from "@/lib/agent-message";

export const runtime = "nodejs";

function deriveSubagentInfo(sessionKey: string): { parentSessionId: string; task: string } | null {
	const registryPath = join(resolveOpenClawStateDir(), "subagents", "runs.json");
	if (!existsSync(registryPath)) {return null;}
	try {
		const raw = JSON.parse(readFileSync(registryPath, "utf-8")) as {
			runs?: Record<string, Record<string, unknown>>;
		};
		for (const entry of Object.values(raw.runs ?? {})) {
			if (entry.childSessionKey !== sessionKey) {continue;}
			const requester = typeof entry.requesterSessionKey === "string" ? entry.requesterSessionKey : "";
			const match = requester.match(/^agent:[^:]+:web:(.+)$/);
			const parentSessionId = match?.[1] ?? "";
			const task = typeof entry.task === "string" ? entry.task : "";
			return { parentSessionId, task };
		}
	} catch {
		// ignore
	}
	return null;
}

function normalizeLiveStreamEvent(event: SseEvent): SseEvent | null {
	// `user-message` events are internal bookkeeping for the reconnection
	// stream parser — they are not part of the AI SDK v6 wire format and
	// will fail validation in DefaultChatTransport.  Filter them out.
	if (event.type === "user-message") {
		return null;
	}

	// AI SDK's UI stream schema does not define `tool-output-partial`.
	// It expects repeated `tool-output-available` chunks with
	// `preliminary: true` while the tool is still running.
	if (event.type === "tool-output-partial") {
		return {
			type: "tool-output-available",
			toolCallId: event.toolCallId,
			output: event.output,
			preliminary: true,
		};
	}

	return event;
}

export async function POST(req: Request) {
	const {
		messages,
		sessionId,
		sessionKey,
		distinctId,
		userHtml,
		modelOverride,
		acknowledgeUnsafeOpenAiSwitch,
		hasAssistantHistory: hasAssistantHistoryHint,
		workspaceContext,
	}: {
		messages: UIMessage[];
		sessionId?: string;
		sessionKey?: string;
		distinctId?: string;
		userHtml?: string;
		modelOverride?: string;
		acknowledgeUnsafeOpenAiSwitch?: boolean;
		hasAssistantHistory?: boolean;
		workspaceContext?: WorkspaceContext;
	} = await req.json();

	const lastUserMessage = messages.filter((m) => m.role === "user").pop();
	const userText =
		lastUserMessage?.parts
			?.filter(
				(p): p is { type: "text"; text: string } =>
					p.type === "text",
			)
			.map((p) => p.text)
			.join("\n") ?? "";

	if (!userText.trim()) {
		return new Response("No message provided", { status: 400 });
	}

	trackServer(
		"chat_message_sent",
		{
			message_length: userText.length,
			is_subagent: typeof sessionKey === "string" && sessionKey.includes(":subagent:"),
		},
		distinctId,
	);

	const isSubagentSession = typeof sessionKey === "string" && sessionKey.includes(":subagent:");
	const backend = resolveAgentBackend();
	const normalizedModelOverride =
		typeof modelOverride === "string" && modelOverride.trim()
			? modelOverride.trim()
			: undefined;

	if (
		sessionId &&
		normalizedModelOverride &&
		isLikelyOpenAiModelId(normalizedModelOverride) &&
		!isSubagentSession
	) {
		const hasAssistantHistory = hasAssistantHistoryHint ?? messages.some((m) => m.role === "assistant");
		const runtimeSession = getAgentSession(sessionId);
		const meta = getSessionMeta(sessionId);
		const kind = classifyOpenAiModelSwitch({
			sessionModel: runtimeSession?.model ?? null,
			sessionModelProvider: runtimeSession?.modelProvider ?? null,
			targetModel: normalizedModelOverride,
		});
		const alreadyReset = hasRotatedGatewayThread(meta, sessionId);
		const needsAck =
			!alreadyReset &&
			needsOpenAiSwitchAcknowledgement(kind, hasAssistantHistory);

		if (needsAck && !acknowledgeUnsafeOpenAiSwitch) {
			return Response.json(
				{
					code: "openai_unsafe_switch",
					message:
						"Switching this chat to ChatGPT can invalidate earlier tool-call history from other models. Confirm below to continue with a fresh model context for this thread.",
				},
				{ status: 409 },
			);
		}
		if (needsAck && acknowledgeUnsafeOpenAiSwitch) {
			rotateGatewaySessionThreadForModelReset(sessionId);
		}
	}

	if (backend !== "hermes" && !isSubagentSession && sessionId && hasActiveRun(sessionId)) {
		return new Response("Active run in progress", { status: 409 });
	}
	if (backend !== "hermes" && isSubagentSession && sessionKey) {
		const existingRun = getActiveRun(sessionKey);
		if (existingRun?.status === "running") {
			return new Response("Active subagent run in progress", { status: 409 });
		}
	}

	// Build the prompt the agent sees. With workspaceContext sent as a
	// structured body field (post v3-chat refactor), prefixes are
	// reconstructed here rather than parsed back out of userText. Legacy
	// callers without workspaceContext still work because buildAgentMessage
	// returns userText unchanged when no context is supplied.
	const wsPrefix = resolveAgentWorkspacePrefix();
	const agentMessage = buildAgentMessage({
		userText,
		workspaceContext,
		workspacePrefix: wsPrefix,
	});
	const imageHydration = hydrateMessageImageAttachments(agentMessage);
	const imageHydrationError = buildChatImageHydrationErrorMessage(
		imageHydration.skipped,
	);
	if (imageHydrationError) {
		return new Response(imageHydrationError, { status: 400 });
	}
	const imageAttachments = imageHydration.attachments.length > 0
		? imageHydration.attachments
		: undefined;

	if (backend === "hermes") {
		if (isSubagentSession) {
			return new Response("Subagent sessions are unavailable with Hermes backend", {
				status: 409,
			});
		}

		if (sessionId && lastUserMessage) {
			await persistUserMessage(sessionId, {
				id: lastUserMessage.id,
				content: userText,
				parts: lastUserMessage.parts as unknown[],
				html: userHtml,
			});
		}

		const hermesSessionKey = sessionId ?? sessionKey;
		if (!hermesSessionKey) {
			return new Response("sessionId is required for Hermes chat", { status: 400 });
		}

		const hermesStream = await createHermesChatStream({
			sessionKey: hermesSessionKey,
			message: agentMessage,
			config: resolveHermesConfig(),
		});

		// Accumulate assistant text + parts for persistence.  The raw stream
		// emits AI-SDK UI chunks (text-delta, reasoning-delta, etc.)
		// so we tap into it without altering what the client receives.
		let assistantText = "";
		let assistantId = `assistant_${Date.now()}`;
		const parts: Array<Record<string, unknown>> = [];
		let currentText = "";
		let hasTextPart = false;
		let currentReasoning = "";
		let hasReasoningPart = false;
		const toolParts = new Map<string, Record<string, unknown>>();

		function flushTextPart() {
			if (currentText) {
				if (!hasTextPart) {
					parts.push({ type: "text", text: currentText });
					hasTextPart = true;
				} else {
					// Append to existing text part
					const last = parts[parts.length - 1];
					if (last?.type === "text") {
						(last as { text: string }).text += currentText;
					}
				}
				currentText = "";
			}
		}

		function flushReasoningPart() {
			if (currentReasoning) {
				parts.push({ type: "reasoning", text: currentReasoning });
				currentReasoning = "";
				hasReasoningPart = true;
			}
		}

		const persistStream = hermesStream.pipeThrough(
			new TransformStream<Uint8Array, Uint8Array>({
				transform(chunk, controller) {
					controller.enqueue(chunk);
					const decoded = new TextDecoder().decode(chunk);
					for (const line of decoded.split("\n")) {
						if (!line.startsWith("data: ")) continue;
						try {
							const evt = JSON.parse(line.slice(6));
							switch (evt.type) {
								case "text-delta":
									if (typeof evt.delta === "string") {
										assistantText += evt.delta;
										currentText += evt.delta;
									}
									break;
								case "text-end":
									flushTextPart();
									break;
								case "reasoning-delta":
									if (typeof evt.delta === "string") {
										currentReasoning += evt.delta;
									}
									break;
								case "reasoning-end":
									flushReasoningPart();
									break;
								case "tool-input-start":
									if (evt.toolCallId) {
										toolParts.set(evt.toolCallId, {
											type: "tool-invocation",
											toolCallId: evt.toolCallId,
											toolName: evt.toolName ?? "unknown",
											state: "call",
											args: {},
										});
									}
									break;
								case "tool-input-available":
									if (evt.toolCallId && toolParts.has(evt.toolCallId)) {
										const tp = toolParts.get(evt.toolCallId)!;
										const input = evt.input;
										// Hermes sends preview as a string; wrap it in an object
										// so the UI can read args.query, args.preview, etc.
										(tp as Record<string, unknown>).args = typeof input === "string"
											? { query: input, preview: input }
											: (input ?? {});
										(tp as Record<string, unknown>).state = "call";
									}
									break;
								case "tool-output-available":
									if (evt.toolCallId && toolParts.has(evt.toolCallId)) {
										const tp = toolParts.get(evt.toolCallId)!;
										(tp as Record<string, unknown>).result = evt.output ?? "";
										(tp as Record<string, unknown>).state = "result";
									}
									break;
								case "tool-output-error":
									if (evt.toolCallId && toolParts.has(evt.toolCallId)) {
										const tp = toolParts.get(evt.toolCallId)!;
										(tp as Record<string, unknown>).errorText = evt.output ?? "Error";
										(tp as Record<string, unknown>).state = "result";
									}
									break;
							}
						} catch { /* ignore non-JSON */ }
					}
				},
				async flush() {
					// Flush any remaining text/reasoning
					flushTextPart();
					flushReasoningPart();

					// Add tool parts in insertion order
					for (const tp of toolParts.values()) {
						parts.push(tp);
					}

					if (assistantText.trim() && sessionId) {
						await persistAssistantMessage(sessionId, {
							id: assistantId,
							content: assistantText,
							parts,
						}).catch((err) =>
							console.error("[hermes] Failed to persist assistant message:", err),
						);
					}
				},
			}),
		);

		return new Response(persistStream, {
			headers: {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache, no-transform",
				Connection: "keep-alive",
				"X-Agent-Backend": "hermes",
			},
		});
	}

	const runKey = isSubagentSession && sessionKey ? sessionKey : (sessionId as string);

	if (isSubagentSession && sessionKey && lastUserMessage) {
		let run = getActiveRun(sessionKey);
		if (!run) {
			const info = deriveSubagentInfo(sessionKey);
			if (!info) {
				return new Response("Subagent not found", { status: 404 });
			}
			run = startSubscribeRun({
				sessionKey,
				parentSessionId: info.parentSessionId,
				task: info.task,
			});
		}
		await persistSubscribeUserMessage(sessionKey, {
			id: lastUserMessage.id,
			text: userText,
		});
		reactivateSubscribeRun(sessionKey, agentMessage, imageAttachments);
	} else if (sessionId && lastUserMessage) {
		await persistUserMessage(sessionId, {
			id: lastUserMessage.id,
			content: userText,
			parts: lastUserMessage.parts as unknown[],
			html: userHtml,
		});

		const sessionMeta = getSessionMeta(sessionId);
		const effectiveAgentId =
			sessionMeta?.workspaceAgentId
			?? resolveActiveAgentId();
		const gatewayThreadId = sessionMeta?.gatewaySessionId ?? sessionId;

		try {
			startRun({
				sessionId,
				message: agentMessage,
				agentSessionId: gatewayThreadId,
				overrideAgentId: effectiveAgentId,
				modelOverride: normalizedModelOverride,
				imageAttachments,
			});
		} catch (err) {
			return new Response(
				err instanceof Error ? err.message : String(err),
				{ status: 500 },
			);
		}
	}

	const encoder = new TextEncoder();
	let closed = false;
	let unsubscribe: (() => void) | null = null;
	let keepalive: ReturnType<typeof setInterval> | null = null;

	const stream = new ReadableStream({
		start(controller) {
			if (!runKey) {
				controller.close();
				return;
			}

			keepalive = setInterval(() => {
				if (closed) {return;}
				try {
					controller.enqueue(encoder.encode(": keepalive\n\n"));
				} catch { /* ignore enqueue errors on closed stream */ }
			}, 15_000);

		unsubscribe = subscribeToRun(
			runKey,
			(event: SseEvent | null) => {
				if (closed) {return;}
				if (event === null) {
						closed = true;
						if (keepalive) { clearInterval(keepalive); keepalive = null; }
						try { controller.close(); } catch { /* already closed */ }
						return;
					}
					try {
						const normalized = normalizeLiveStreamEvent(event);
						if (normalized) {
							const json = JSON.stringify(normalized);
							controller.enqueue(encoder.encode(`data: ${json}\n\n`));
						}
					} catch { /* ignore */ }
				},
				{ replay: true },
			);

			if (!unsubscribe) {
				closed = true;
				if (keepalive) { clearInterval(keepalive); keepalive = null; }
				controller.close();
			}
		},
		cancel() {
			closed = true;
			if (keepalive) { clearInterval(keepalive); keepalive = null; }
			unsubscribe?.();
		},
	});

	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive",
		},
	});
}
