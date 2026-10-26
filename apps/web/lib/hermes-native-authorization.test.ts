import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./postgres",()=>({queryPg:vi.fn()}));
vi.mock("./workspace",()=>({discoverWorkspaces:()=>[{name:"agent"}]}));
vi.mock("./auth",()=>({ALLOWED_EMAILS:new Set(["admin@example.test"])}));
vi.mock("./hermes-session-names",()=>({sessionDisplayNames:vi.fn(async()=>({}))}));
vi.mock("./hermes-session-projects",()=>({sessionProjectLabels:vi.fn(async()=>({}))}));
vi.mock("./hermes-session-activity",()=>({recentSessionActivity:vi.fn(async()=>new Map())}));
import { queryPg } from "./postgres";
import { sessionProjectLabels } from "./hermes-session-projects";
import { recentSessionActivity } from "./hermes-session-activity";
import { createConversation, listConversations, readConversation } from "./hermes-native";
import { conversationKey } from "./hermes-conversations";
const actor={id:"owner",email:"owner@example.test",displayName:"Owner"};
const row={owner_id:"owner",creator_id:"owner",origin:"crm",visibility:"private",version:1,deleted_at:null};
beforeEach(()=>{vi.clearAllMocks();vi.mocked(queryPg).mockReset();vi.stubEnv("HERMES_API_BASE_URL","http://synthetic.invalid");vi.stubEnv("HERMES_API_KEY","synthetic");vi.stubEnv("HERMES_GATEWAY_WS_URL","");vi.stubEnv("HERMES_CHAT_TRANSPORT","sse");});
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();});
describe("native conversation authorization",()=>{
 it("reads only the actor's own and team-shared chats from the index, newest first, and never enriches others",async()=>{
  vi.mocked(queryPg).mockImplementation(async(sql,params)=>String(sql).includes("row_number")?[{stored_id:"mine",source:"crm",title:"My chat",last_active:5,started_at:1,...row,rank:1}]:String(sql).includes("jsonb_to_recordset")&&String(sql).startsWith("select")?JSON.parse(String(params?.[0])).map((identity:object)=>({...identity,...row})):[]);
  vi.stubGlobal("fetch",vi.fn(async()=>Response.json({data:[{id:"mine",source:"crm",title:"My chat"}]})));
  const result=await listConversations(actor);
  expect(result.sessions.map(session=>session.id)).toEqual(["mine"]);
  const listing=vi.mocked(queryPg).mock.calls.find(([sql])=>String(sql).includes("row_number"));
  expect(listing?.[1]).toEqual(["agent",actor.id,100,[],""]);
  expect(sessionProjectLabels).toHaveBeenCalledWith("agent",["mine"]);expect(recentSessionActivity).toHaveBeenCalledWith("agent",["mine"]);
 });
 it("surfaces a registry outage as 503 instead of silently returning partial results",async()=>{
  vi.mocked(queryPg).mockImplementation(async(sql)=>{if(String(sql).includes("session_index")&&String(sql).includes("insert into hermes_security.conversation_access"))throw Error("private storage detail");return [];});
  vi.stubGlobal("fetch",vi.fn(async()=>Response.json({data:[{id:"mine",source:"crm"}]})));
  await expect(listConversations(actor)).rejects.toMatchObject({status:503,message:"conversation_access_unavailable"});expect(sessionProjectLabels).not.toHaveBeenCalled();
 });
 it("persists private browser ownership before any native create call",async()=>{
  vi.mocked(queryPg).mockRejectedValueOnce(Error("write failed"));const fetch=vi.fn();vi.stubGlobal("fetch",fetch);
  await expect(createConversation(["agent"],undefined,actor)).rejects.toMatchObject({status:503});expect(fetch).not.toHaveBeenCalled();
 });
 it("conceals unregistered web sessions, even from an admin",async()=>{
  vi.mocked(queryPg).mockResolvedValue([]);const fetch=vi.fn(async()=>Response.json({session:{id:"legacy",source:"web"}}));vi.stubGlobal("fetch",fetch);
  await expect(readConversation(conversationKey("solo","legacy","agent"),0,undefined,{...actor,email:"admin@example.test"})).rejects.toMatchObject({status:404});
  expect(fetch).toHaveBeenCalledTimes(1);expect(queryPg).toHaveBeenCalledTimes(1);
 });
 it("withholds a transcript when access is revoked during its upstream read",async()=>{
  let visibility="team";
  vi.mocked(queryPg).mockImplementation(async()=>[{...row,visibility}]);
  vi.stubGlobal("fetch",vi.fn(async(url:string)=>Response.json(url.includes("/messages?")
    ? {data:[{id:1,role:"assistant",content:"private transcript"}]}
    : {session:{id:"shared",source:"crm",title:"Shared chat"}})));
  vi.mocked(sessionProjectLabels).mockImplementationOnce(async()=>{visibility="private";return {};});
  await expect(readConversation(conversationKey("solo","shared","agent"),0,undefined,{...actor,id:"recipient"})).rejects.toMatchObject({status:404});
 });
 it("rejects group aliases without discovering any native state",async()=>{
  const fetch=vi.fn();vi.stubGlobal("fetch",fetch);
  await expect(readConversation(conversationKey("group","room","alias"),0,undefined,actor)).rejects.toMatchObject({status:404});expect(fetch).not.toHaveBeenCalled();expect(queryPg).not.toHaveBeenCalled();
 });
});
