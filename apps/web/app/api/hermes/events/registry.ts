import { randomUUID } from "node:crypto";
import { canonicalIdentity, requireActor, type ConversationActor } from "@/lib/conversation-access";
import { ChatServiceError, getHermesChatService, type HermesChatService } from "@/lib/hermes-gateway/chat-service";
import type { GatewaySessionEvent } from "@/lib/hermes-gateway/manager";
import { MAX_SUBSCRIPTIONS } from "./subscription-limits";

type Delivery = { event: string; payload: unknown; id?: string };
type Subscription = { resyncing: boolean; subscriptionId?: string; pending: Set<Delivery>; stop: () => void; alive: boolean; version: number; held: GatewaySessionEvent[] };
/** Each content emission rechecks the login and durable ACL. The idle sweep bounds revocation to 5s. */
export class EventConnection {
  readonly id = randomUUID();
  readonly userId: string;
  private readonly subscriptions = new Map<string, Subscription>();
  private closed = false;
  private tail: Promise<void> = Promise.resolve();
  private delivery: Promise<void> = Promise.resolve();
  private readonly stopNotices: () => void;
  private readonly timer: ReturnType<typeof setInterval>;
  constructor(private readonly actor: ConversationActor, private readonly emit: (event: string, payload: unknown, id?: string, version?: number) => void, private readonly service: HermesChatService = getHermesChatService(), private readonly revalidate: () => Promise<ConversationActor | null> = async () => null) {
    this.userId = requireActor(actor).id;
    this.stopNotices = service.manager.subscribeNotices(notice => {
      if (this.closed) {return;}
      if (notice.type === "gateway") { void this.revalidate().then(actor => { if (!this.closed && actor?.id === this.userId) {this.emit("gateway",{state:notice.state});} }).catch(() => {}); return; }
      for (const key of this.subscriptions.keys()) {
        if (service.retainedKey(key) !== notice.key) {continue;}
        const sub=this.subscriptions.get(key)!;
        this.resync(key,sub,notice.reason ?? "gateway_resync");
      }
    });
    this.timer = setInterval(() => { for (const [key, sub] of this.subscriptions) {void this.check(key,sub);} },5000);
    this.timer.unref?.();
  }
  private resync(key: string, sub: Subscription, reason: string) {
    if (sub.resyncing || !sub.alive) {return;}
    sub.resyncing=true;
    this.queue(key,"resync",{key,reason,subscriptionId:sub.subscriptionId});
    void this.delivery.then(() => {
      if (sub.alive && this.subscriptions.get(key) === sub) {return this.update([key],[],undefined,sub.subscriptionId?{[key]:sub.subscriptionId}:{});}
    }).catch(() => {});
  }
  private revoke(key: string, sub: Subscription) {
    if (this.subscriptions.get(key) !== sub) {return;}
    sub.alive = false; sub.held.length = 0; for (const item of sub.pending) {item.payload=undefined;} sub.pending.clear(); sub.stop(); this.subscriptions.delete(key);
    this.emit("access-revoked",{key});
  }
  private async check(key: string, sub: Subscription): Promise<boolean> {
    if (this.closed || !sub.alive || this.subscriptions.get(key) !== sub) {return false;}
    try {
      const actor = await this.revalidate();
      if (!actor || actor.id !== this.userId) {throw Error();}
      const result = await this.service.authorize(actor,key);
      if (this.closed || !sub.alive || this.subscriptions.get(key) !== sub) {return false;}
      // A visibility change invalidates old snapshots and held frames, even if access remains.
      if (result.version !== sub.version) { this.revoke(key,sub); return false; }
      return true;
    } catch { this.revoke(key,sub); return false; }
  }
  private queue(key: string,event: string,payload: unknown,id?: string) {
    const sub = this.subscriptions.get(key);
    if (!sub) {return;}
    if (sub.pending.size >= 4096) { this.revoke(key,sub); return; }
    const item: Delivery = {event,payload,id}; sub.pending.add(item);
    this.delivery = this.delivery.then(async () => {
      if (await this.check(key,sub)) {this.emit(item.event,item.payload,item.id,sub.version);}
      item.payload=undefined; sub.pending.delete(item);
    }).catch(() => this.revoke(key,sub));
  }
  emitGatewayState(): void {
    void this.revalidate().then(actor => { if (!this.closed && actor?.id === this.userId) {this.emit("gateway",{state:this.service.manager.connectionState()});} }).catch(() => {});
  }
  update(add: string[], remove: string[], cursor?: { generation: number; seq: number }, subscriptionIds: Record<string,string> = {}): Promise<void> {
    const operation = this.tail.then(async () => {
      if (this.closed) {return;}
      const actor = await this.revalidate();
      if (!actor || actor.id !== this.userId) { this.close(); throw new ChatServiceError(401,"Unauthorized"); }
      const next = new Set(this.subscriptions.keys()); remove.forEach(key => next.delete(key)); add.forEach(key => next.add(key));
      if (next.size > MAX_SUBSCRIPTIONS) {throw new ChatServiceError(400,"invalid_subscriptions");}
      // Authorize the whole addition before touching snapshots or exposing metadata.
      const grants = new Map<string,number>();
      for (const key of add) { const identity = canonicalIdentity(key); if (identity.kind !== "solo") {throw new ChatServiceError(400,"solo_conversation_required");} grants.set(key,(await this.service.authorize(actor,key)).version); }
      for (const key of [...remove,...add]) {
        const old = this.subscriptions.get(key); if (!old) {continue;}
        old.alive=false; old.held.length=0; for(const item of old.pending) {item.payload=undefined;} old.pending.clear(); old.stop(); this.subscriptions.delete(key);
      }
      for (const key of add) {
        const identity = canonicalIdentity(key); const retained = this.service.retainedKey(key); const subscriptionId = subscriptionIds[key];
        let ready=false; let generation=0; let seq=0;
        const sub: Subscription = {resyncing:false,subscriptionId,pending:new Set(),stop:() => {},alive:true,version:grants.get(key)!,held:[]};
        this.subscriptions.set(key,sub);
        const publish = (event: GatewaySessionEvent) => {
          if (!sub.alive || sub.resyncing || this.closed) {return;}
          if (event.generation === generation && event.seq <= seq) {return;}
          if (generation && event.generation !== generation) { this.resync(key,sub,"generation_change"); return; }
          generation=event.generation; seq=event.seq;
          this.queue(key,"gw",{key,type:event.type,seq,generation,payload:event.payload},`${generation}:${seq}`);
        };
        const unsubscribe = this.service.manager.subscribe(retained,event => {
          if (!sub.alive || this.closed) {return;}
          if (ready) {publish(event);} else if (sub.held.length < 4096) {sub.held.push(event);} else {this.revoke(key,sub);}
        });
        const stopRequests = this.service.subscribeRequests(key,request => this.queue(key,"request",{key,...request}),actor);
        sub.stop=() => {unsubscribe();stopRequests();};
        if (!sub.alive) {sub.stop();continue;}
        try {
          const replay = this.service.manager.eventsSince(retained,cursor?.generation,cursor?.seq);
          const snapshot = await this.service.openForView(identity.profile,identity.id,undefined,actor);
          if (!await this.check(key,sub)) {continue;}
          generation=snapshot.generation;seq=snapshot.seq;
          this.queue(key,"snapshot",{key,...snapshot,...(subscriptionId?{subscriptionId}:{})});
          if (cursor && !replay.truncated && replay.generation === generation) {
            for (const event of replay.events) {this.queue(key,"gw",{key,type:event.type,seq:event.seq,generation:event.generation,payload:event.payload},`${event.generation}:${event.seq}`);}
          }
          ready=true; for (const event of sub.held) {publish(event);} sub.held.length=0;
        } catch (error) { this.revoke(key,sub); throw error; }
      }
      await this.delivery;
    });
    this.tail=operation.catch(() => {}); return operation;
  }
  close(): void {
    this.closed=true; clearInterval(this.timer);this.stopNotices();
    for (const sub of this.subscriptions.values()) { sub.alive=false;sub.held.length=0;for(const item of sub.pending) {item.payload=undefined;}sub.pending.clear();sub.stop(); }
    this.subscriptions.clear();
  }
}
const state = globalThis as typeof globalThis & { __hermesEventConnections?: Map<string,EventConnection> };
export const eventConnections = state.__hermesEventConnections ??= new Map<string,EventConnection>();
