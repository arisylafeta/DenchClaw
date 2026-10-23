import { beforeEach, describe, expect, it, vi } from "vitest";
const state=vi.hoisted(() => ({row:{owner_id:"owner",creator_id:"owner",origin:"crm",visibility:"private",version:1,deleted_at:null} as Record<string,unknown>,fail:false}));
vi.mock("../postgres",()=>({queryPg:vi.fn(async () => {if(state.fail){throw Error("database detail");}return [state.row];})}));
vi.mock("../auth",()=>({ALLOWED_EMAILS:new Set(["admin@example.test"])}));
vi.mock("../hermes-native",()=>({assertProfile:vi.fn(),nativeFetch:vi.fn(async ()=>Response.json({source:"crm"})),readConversation:vi.fn(),soloConversation:(profile:string,row:{id:string})=>({key:encodeURIComponent(JSON.stringify(["solo",profile,row.id])),id:row.id,profile}),hermesProfiles:()=>["agent"],inviteToConversation:vi.fn()}));
vi.mock("./message-html-store",()=>({lookupMessageHtml:vi.fn(async()=>[]),saveMessageHtml:vi.fn()}));
import { HermesChatService } from "./chat-service";
import { conversationKey } from "../hermes-conversations";
const key=conversationKey("solo","stored","agent");
const owner={id:"owner",email:"owner@example.test",displayName:"Owner"};
const other={id:"other",email:"other@example.test",displayName:"Other"};
function fixture(){
 const manager={onServerRequest:vi.fn(),connect:vi.fn(async()=>{}),retainSession:vi.fn(()=>key),call:vi.fn(async()=>({stored_session_id:"minted",session_id:"runtime"})),callSession:vi.fn(),resumeSession:vi.fn(),serialize:vi.fn(async(_key:string,fn:()=>Promise<unknown>)=>fn())};
 return {manager,service:new HermesChatService(manager as unknown as HermesChatService["manager"])};
}
beforeEach(()=>{state.row={owner_id:"owner",creator_id:"owner",origin:"crm",visibility:"private",version:1,deleted_at:null};state.fail=false;vi.clearAllMocks();});
describe("service authorization cannot be skipped by new callers",()=>{
 it("requires an actor before every data-bearing operation",async()=>{
  const f=fixture();
  for(const call of [()=>f.service.openForView("agent","stored"),()=>f.service.historyPage(key,"1"),()=>f.service.sendPrompt(key,{text:"hi"}),()=>f.service.modelOptions(key),()=>f.service.branchConversation(key),()=>f.service.slashComplete(key,{text:"/help"}),()=>f.service.slashExecute(key,{command:"/help"}),()=>f.service.command(key,"interrupt",{}),()=>f.service.createGatewayConversation(["agent"])]) {await expect(call()).rejects.toMatchObject({status:401});}
  expect(()=>f.service.subscribeRequests(key,()=>{})).toThrow("Unauthorized");expect(f.manager.call).not.toHaveBeenCalled();expect(f.manager.connect).not.toHaveBeenCalled();
 });
 it("denies another user before history, gateway attachment, mutation, or derivation",async()=>{
  const f=fixture();
  for(const call of [()=>f.service.openForView("agent","stored",undefined,other),()=>f.service.sendPrompt(key,{text:"hi"},other),()=>f.service.command(key,"interrupt",{},other),()=>f.service.branchConversation(key,other)]) {await expect(call()).rejects.toMatchObject({status:404});}
  expect(f.manager.call).not.toHaveBeenCalled();expect(f.manager.connect).not.toHaveBeenCalled();
 });
 it("does not return a minted conversation when private registration fails",async()=>{
  const f=fixture();state.fail=true;await expect(f.service.createGatewayConversation(["agent"],owner)).rejects.toMatchObject({status:503,message:"conversation_access_unavailable"});
  expect(f.manager.call).toHaveBeenCalledWith("session.create",expect.objectContaining({source:"crm"}));
 });
 it("rechecks permission after waiting for a serialized prompt",async()=>{
  const f=fixture();state.row.visibility="team";
  f.manager.serialize.mockImplementationOnce(async(_key,fn)=>{state.row.visibility="private";return fn();});
  await expect(f.service.sendPrompt(key,{text:"hi"},other)).rejects.toMatchObject({status:404});
  expect(f.manager.resumeSession).not.toHaveBeenCalled();expect(f.manager.callSession).not.toHaveBeenCalled();
 });
 it("team participation never permits privileged approval or recipient-owned branches",async()=>{
  const f=fixture();state.row.visibility="team";
  await expect(f.service.command(key,"approval",{request_id:"pending",choice:"always"},other)).rejects.toMatchObject({status:404});
  await expect(f.service.branchConversation(key,other)).rejects.toMatchObject({status:404});expect(f.manager.call).not.toHaveBeenCalled();
 });
 it.each(["/resume other","/reset","/fork","/model --global","/skill anything","/help --profile other","/help topic\n/reset"])("rejects unsafe generic slash %s",async command=>{
  const f=fixture();await expect(f.service.slashExecute(key,{command},owner)).rejects.toMatchObject({status:400,message:"slash_not_allowed"});expect(f.manager.call).not.toHaveBeenCalled();
 });
 it("rejects attachment hydration and slash injection via direct prompts",async()=>{
  const f=fixture();await expect(f.service.sendPrompt(key,{text:"[Attached files: relative.png]"},owner)).rejects.toMatchObject({status:403});
  await expect(f.service.sendPrompt(key,{text:"/resume another"},owner)).rejects.toMatchObject({status:400});expect(f.manager.connect).not.toHaveBeenCalled();
 });
});
