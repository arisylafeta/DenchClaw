import { randomUUID } from "node:crypto";
import { authorizeConversation, getHermesChatService, type HermesChatService } from "@/lib/hermes-gateway/chat-service";
import type { GatewaySessionEvent } from "@/lib/hermes-gateway/manager";

export class EventConnection {
  readonly id = randomUUID();
  private readonly subscriptions = new Map<string, () => void>();
  private closed = false;
  private tail: Promise<void> = Promise.resolve();
  private readonly stopNotices: () => void;
  constructor(readonly userId: string, private readonly emit: (event: string, payload: unknown, id?: string) => void, private readonly service: HermesChatService = getHermesChatService()) {
    this.stopNotices = service.manager.subscribeNotices(notice => {
      if (this.closed) return;
      if (notice.type === "gateway") { this.emit("gateway", { state: notice.state }); return; }
      for (const key of this.subscriptions.keys()) {
        if (service.retainedKey(key) !== notice.key) continue;
        this.emit("resync", { key, reason: notice.reason });
        void this.update([], [key]).then(() => this.update([key], [])).catch(() => {});
      }
    });
    this.emit("gateway", { state: service.manager.connectionState() });
  }
  update(add: string[], remove: string[], cursor?: { generation: number; seq: number }): Promise<void> {
    const operation = this.tail.then(async () => {
      if (this.closed) return;
      for (const key of remove) { this.subscriptions.get(key)?.(); this.subscriptions.delete(key); }
      for (const key of add) {
        if (this.subscriptions.has(key) || this.closed) continue;
        const identity = authorizeConversation(key);
        const retained = this.service.retainedKey(key);
        let ready = false;
        const held: GatewaySessionEvent[] = [];
        let generation = 0;
        let seq = 0;
        const publish = (event: GatewaySessionEvent) => {
          if (event.generation === generation && event.seq <= seq) return;
          if (generation && event.generation !== generation) {
            this.emit("resync", { key, reason: "generation_change" });
            void this.update([], [key]).then(() => this.update([key], [])).catch(() => {});
            return;
          }
          generation = event.generation; seq = event.seq;
          this.emit("gw", { key, type: event.type, seq, generation, payload: event.payload }, `${generation}:${seq}`);
        };
        const unsubscribe = this.service.manager.subscribe(retained, event => { if (ready) publish(event); else held.push(event); });
        const stopRequests = this.service.subscribeRequests(key, request => this.emit("request", { key, ...request }));
        const stop = () => { unsubscribe(); stopRequests(); };
        this.subscriptions.set(key, stop);
        try {
          const replay = this.service.manager.eventsSince(retained, cursor?.generation, cursor?.seq);
          // A cursor is per-session, not a tab-wide vector. Never apply one session's
          // Last-Event-ID to several sessions: authoritative snapshots recover all keys.
          const snapshot = await this.service.openForView(identity.profile, identity.id);
          if (this.closed) break;
          generation = snapshot.generation; seq = snapshot.seq;
          this.emit("snapshot", { key, ...snapshot });
          if (cursor && !replay.truncated && replay.generation === generation) {
            // Replayed frames can overlap the durable snapshot. Consumers dedupe by seq.
            for (const event of replay.events) this.emit("gw", { key, type: event.type, seq: event.seq, generation: event.generation, payload: event.payload }, `${event.generation}:${event.seq}`);
          }
          ready = true;
          for (const event of held) publish(event);
        } catch (error) {
          stop(); this.subscriptions.delete(key);
          throw error;
        }
      }
    });
    this.tail = operation.catch(() => {});
    return operation;
  }
  close(): void {
    this.closed = true;
    this.stopNotices();
    for (const unsubscribe of this.subscriptions.values()) unsubscribe();
    this.subscriptions.clear();
  }
}
const state = globalThis as typeof globalThis & { __hermesEventConnections?: Map<string, EventConnection> };
export const eventConnections = state.__hermesEventConnections ??= new Map<string, EventConnection>();
