import { beforeEach, describe, expect, it, vi } from "vitest";
const actor={id:"u1",email:"user@example.test",displayName:"User"};
const other={...actor,id:"u2"};
const rows = new Map<string, Set<string>>();
vi.mock("@/lib/postgres", () => ({ queryPg: vi.fn(async (sql: string, params: string[]) => {
  const [user, key] = params;
  if (sql.startsWith("insert")) { (rows.get(user) ?? rows.set(user, new Set()).get(user)!).add(key); return []; }
  if (sql.startsWith("delete")) { rows.get(user)?.delete(key); return []; }
  return [...(rows.get(user) ?? [])].map((conversation_key) => ({ conversation_key }));
}) }));
const nativeFetch = vi.fn(); const groupRpc = vi.fn();
vi.mock("@/lib/hermes-native", () => ({ authorizeNativeConversation:async(actor:unknown,key:string)=>{ const {canonicalIdentity,requireActor}=await import("./conversation-access");requireActor(actor as never);canonicalIdentity(key);return {access:{visibility:"team"},version:1}; }, assertProfile: (p: string) => { if (p !== "alpha") throw new Error("Unknown Hermes profile"); }, nativeFetch: (...a: unknown[]) => nativeFetch(...a), groupRpc: (...a: unknown[]) => groupRpc(...a) }));
import { conversationKey } from "@/lib/hermes-conversations";
import { PinError, setPin, listPins } from "./hermes-pins";
const solo = conversationKey("solo", "s1", "alpha");
const room = conversationKey("group", "r1");
beforeEach(() => { rows.clear(); nativeFetch.mockReset().mockResolvedValue({ status: 200 }); groupRpc.mockReset().mockResolvedValue({}); });
describe("hermes pins", () => {
  it("pins solo chats and groups idempotently and reads back", async () => {
    expect(await setPin("u1", solo, true, actor)).toEqual([solo]);
    expect(await setPin("u1", solo, true, actor)).toEqual([solo]);
    expect(await setPin("u1", room, true, actor)).toEqual([solo, room]);
    expect(await setPin("u1", solo, false, actor)).toEqual([room]);
    expect(await setPin("u1", solo, false, actor)).toEqual([room]);
  });
  it("isolates users", async () => {
    await setPin("u1", solo, true, actor);
    expect(await listPins("u2", other)).toEqual([]);
    await setPin("u2", solo, false, other);
    expect(await listPins("u1", actor)).toEqual([solo]);
  });
  it("rejects malformed, unknown-profile and missing targets without writing", async () => {
    await expect(setPin("u1", "nope", true, actor)).rejects.toMatchObject({ status: 404 });
    await expect(setPin("u1", conversationKey("solo", "s1", "ghost"), true, actor)).rejects.toMatchObject({ status: 404 });
    nativeFetch.mockResolvedValue({ status: 404 });
    await expect(setPin("u1", solo, true, actor)).rejects.toBeInstanceOf(PinError);
    groupRpc.mockRejectedValue(new Error("no room"));
    await expect(setPin("u1", room, true, actor)).rejects.toMatchObject({ status: 404 });
    expect(await listPins("u1", actor)).toEqual([]);
  });
  it("lets a stale pin be removed even when the chat is gone", async () => {
    await setPin("u1", solo, true, actor);
    nativeFetch.mockResolvedValue({ status: 404 });
    expect(await setPin("u1", solo, false, actor)).toEqual([]);
  });
});
