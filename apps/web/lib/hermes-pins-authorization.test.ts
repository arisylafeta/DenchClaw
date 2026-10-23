import { beforeEach, describe, expect, it, vi } from "vitest";
const state=vi.hoisted(()=>({revoked:false,writes:0}));
vi.mock("./auth",()=>({ALLOWED_EMAILS:new Set()}));
vi.mock("./postgres",()=>({queryPg:vi.fn(async(sql:string,params:unknown[])=>{
 if(sql.includes("from crm_user_chat_pins")){return [{conversation_key:encodeURIComponent(JSON.stringify(["solo","agent","mine"]))},{conversation_key:encodeURIComponent(JSON.stringify(["solo","agent","foreign"]))}];}
 if(sql.includes("from hermes_security")){return [{owner_id:params[2]==="mine"&&!state.revoked?"user":"someone-else",creator_id:"user",origin:"crm",visibility:"private",version:1,deleted_at:null}];}
 state.writes++;return [];
})}));
vi.mock("./hermes-native",async()=>{
 const {authorizeAccess}=await import("./conversation-access");
 return {authorizeNativeConversation:authorizeAccess,assertProfile:vi.fn(),nativeFetch:vi.fn(),groupRpc:vi.fn()};
});
import { listPins, setPin } from "./hermes-pins";
import { conversationKey } from "./hermes-conversations";
const actor={id:"user",email:"user@example.test",displayName:"User"};
beforeEach(()=>{state.revoked=false;state.writes=0;});
describe("pin privacy",()=>{
 it("filters inaccessible keys and stops returning revoked pins",async()=>{
  expect(await listPins(actor.id,actor)).toEqual([conversationKey("solo","mine","agent")]);state.revoked=true;expect(await listPins(actor.id,actor)).toEqual([]);
 });
 it("does not pin a known but inaccessible conversation",async()=>{
  await expect(setPin(actor.id,conversationKey("solo","foreign","agent"),true,actor)).rejects.toMatchObject({status:404});expect(state.writes).toBe(0);
 });
 it("requires the actor to match the pin owner on reads and writes",async()=>{
  await expect(listPins("different-user",actor)).rejects.toMatchObject({status:404});await expect(setPin("different-user",conversationKey("solo","mine","agent"),false,actor)).rejects.toMatchObject({status:404});expect(state.writes).toBe(0);
 });
});
