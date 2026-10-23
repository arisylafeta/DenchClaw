import { beforeEach, describe, expect, it, vi } from "vitest";
const fixture=vi.hoisted(() => ({actor:{id:"other",email:"other@example.test",displayName:"Other"} as {id:string,email:string,displayName:string}|null,row:{owner_id:"owner",creator_id:"owner",origin:"crm",visibility:"private",version:1,deleted_at:null} as Record<string,unknown>,fail:false}));
vi.mock("@/lib/auth",() => ({currentUser:async () => fixture.actor,ALLOWED_EMAILS:new Set(["admin@example.test"])}));
vi.mock("@/lib/postgres",() => ({queryPg:vi.fn(async (sql:string,params:unknown[]) => {
 if(fixture.fail) {throw Error("database connection credentials detail");}
 if(sql.startsWith("update") && sql.includes("visibility=")) {fixture.row={...fixture.row,visibility:params[4],version:Number(fixture.row.version)+1};return [fixture.row];}
 return [fixture.row];
})}));
vi.mock("@/lib/agent-backend",() => ({resolveAgentBackend:() => "hermes"}));
vi.mock("@/lib/hermes-native",async () => {
 const {authorizeAccess}=await import("@/lib/conversation-access");
 return {authorizeNativeConversation:authorizeAccess,assertProfile:vi.fn(),nativeFetch:vi.fn(),groupRpc:vi.fn(),readConversation:vi.fn(async () => ({conversation:{title:"private title"},messages:[{text:"private transcript"}]}))};
});
vi.mock("@/lib/hermes-client",() => ({stopNativeHermesStream:vi.fn()}));
vi.mock("@/lib/hermes-gateway/room-activity",() => ({readRoomActivity:vi.fn()}));
vi.mock("@/lib/hermes-gateway/room-trace",() => ({readRoomTrace:vi.fn()}));
import { GET, PATCH, DELETE, POST } from "./[key]/route";
import { GET as activity } from "./[key]/activity/route";
import { GET as trace } from "./[key]/trace/route";
import { GET as sharing, PATCH as share } from "./[key]/sharing/route";
import { groupRpc, nativeFetch, readConversation } from "@/lib/hermes-native";
import { conversationKey } from "@/lib/hermes-conversations";
const key=conversationKey("solo","stored","agent");
const context={params:Promise.resolve({key})};
const request=(body:unknown={})=>new Request("http://local?member=member&turn=turn",{method:"POST",body:JSON.stringify(body)});
beforeEach(() => {fixture.actor={id:"other",email:"other@example.test",displayName:"Other"};fixture.row={owner_id:"owner",creator_id:"owner",origin:"crm",visibility:"private",version:1,deleted_at:null};fixture.fail=false;vi.clearAllMocks();});
describe("conversation route privacy",() => {
 it.each(["other@example.test","admin@example.test"])("conceals direct private endpoints from %s",async email => {
  fixture.actor!.email=email;
  for(const call of [GET,PATCH,DELETE,POST,activity,trace,sharing,share]) {
   const response=await call(request({visibility:"team"}),context);
   expect(response.status).toBe(404);expect(await response.json()).toEqual({error:"not_found"});
  }
  expect(nativeFetch).not.toHaveBeenCalled();expect(groupRpc).not.toHaveBeenCalled();expect(readConversation).not.toHaveBeenCalled();
 });
 it("returns a fixed unavailable response on ACL-store failure before reading Hermes",async () => {
  fixture.fail=true;const response=await GET(new Request("http://local"),context);
  expect(response.status).toBe(503);expect(await response.json()).toEqual({error:"conversation_access_unavailable"});expect(readConversation).not.toHaveBeenCalled();
 });
 it("allows team reads but reserves sharing and deletion to the owner",async () => {
  fixture.row.visibility="team";expect((await GET(new Request("http://local"),context)).status).toBe(200);
  expect((await DELETE(request(),context)).status).toBe(404);expect((await share(request({visibility:"private"}),context)).status).toBe(404);
 });
 it("returns exactly the UI sharing contract after owner read-back",async () => {
  fixture.actor!.id="owner";const response=await share(request({visibility:"team"}),context);
  expect(response.status).toBe(200);expect(await response.json()).toEqual({access:{visibility:"team",ownerId:"owner",canShare:true,canDelete:true,canWrite:true,canApprove:false}});
 });
 it("never exposes deleted rows or treats invalid group aliases as new objects",async () => {
  fixture.actor!.id="owner";fixture.row.deleted_at="now";
  expect((await GET(new Request("http://local"),context)).status).toBe(404);
  fixture.row.deleted_at=null;
  expect((await GET(new Request("http://local"),{params:Promise.resolve({key:conversationKey("group","room","alias")})})).status).toBe(404);
 });
 it("rejects anonymous calls without touching Hermes",async () => {
  fixture.actor=null;for(const call of [GET,PATCH,DELETE,POST,activity,trace,sharing,share]) {expect((await call(request(),context)).status).toBe(401);}
  expect(nativeFetch).not.toHaveBeenCalled();expect(readConversation).not.toHaveBeenCalled();
 });
});
