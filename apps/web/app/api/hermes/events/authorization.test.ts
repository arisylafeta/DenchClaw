import { afterEach, describe, expect, it, vi } from "vitest";
import { EventConnection } from "./registry";
import { conversationKey } from "@/lib/hermes-conversations";
import type { HermesChatService } from "@/lib/hermes-gateway/chat-service";
const actor = {id:"owner",email:"owner@example.test",displayName:"Owner"};
const key = conversationKey("solo","stored","agent");
const connections: EventConnection[]=[];
afterEach(() => { connections.forEach(c => c.close());connections.length=0; });
function setup() {
 let version=1; let allowed=true; let signedIn=true;
 let event: (e:unknown)=>void = () => {}; let notice: (e:unknown)=>void = () => {}; let request: (e:unknown)=>void = () => {};
 const emitted: {event:string,payload:unknown}[]=[];
 const service = {
  authorize:vi.fn(async () => { if (!allowed) {throw Error("denied");} return {version,access:{visibility:"private"}}; }),
  retainedKey:vi.fn(() => key),subscribeRequests:vi.fn((_key:string,fn:typeof request) => {request=fn;return vi.fn();}),
  openForView:vi.fn(async () => ({generation:1,seq:0,messages:[{text:"private transcript"}]})),
  manager:{subscribeNotices:vi.fn((fn:typeof notice) => {notice=fn;return vi.fn();}),subscribe:vi.fn((_key:string,fn:typeof event) => {event=fn;return vi.fn();}),eventsSince:vi.fn(() => ({generation:1,seq:0,events:[],truncated:false})),connectionState:()=>"connected"},
 };
 const connection = new EventConnection(actor,(event,payload)=>emitted.push({event,payload}),service as unknown as HermesChatService,async () => signedIn?actor:null);connections.push(connection);
 return {connection,service,emitted,event:(payload:unknown)=>event({generation:1,seq:1,type:"message.delta",payload}),request:(payload:unknown)=>request(payload),revoke:()=>{allowed=false;},bump:()=>{version++;},logout:()=>{signedIn=false;}};
}
const flush=async () => { for(let n=0;n<30;n++) {await Promise.resolve();} };
describe("revocation-aware event delivery",() => {
 it("authorizes before loading any snapshot",async () => {
  const f=setup();f.revoke();await expect(f.connection.update([key],[])).rejects.toThrow();expect(f.service.openForView).not.toHaveBeenCalled();expect(f.emitted).toEqual([]);
 });
 it("drops a snapshot and held content revoked during its await",async () => {
  const f=setup();let release!:()=>void;
  f.service.openForView.mockImplementationOnce(async () => {await new Promise<void>(r=>{release=r;});return {generation:1,seq:0,messages:[{text:"private transcript"}]};});
  const adding=f.connection.update([key],[]); await flush(); f.event({text:"held private delta"});f.revoke();release();await adding;await flush();
  expect(f.emitted).toEqual([{event:"access-revoked",payload:{key}}]);
 });
 it("drops queued events and requests after a visibility-version change",async () => {
  const f=setup();await f.connection.update([key],[]);f.emitted.length=0;
  f.event({text:"queued private delta"});f.request({params:{text:"private approval"}});f.bump();await flush();
  expect(f.emitted).toEqual([{event:"access-revoked",payload:{key}}]);
 });
 it("revalidates login before each live emission",async () => {
  const f=setup();await f.connection.update([key],[]);f.emitted.length=0;f.logout();f.event({text:"private delta"});await flush();
  expect(f.emitted).toEqual([{event:"access-revoked",payload:{key}}]);
 });
 it("does not publish an awaited snapshot after closing",async () => {
  const f=setup();let release!:()=>void;
  f.service.openForView.mockImplementationOnce(async () => {await new Promise<void>(r=>{release=r;});return {generation:1,seq:0,messages:[{text:"private transcript"}]};});
  const adding=f.connection.update([key],[]);await flush();f.connection.close();release();await adding;expect(f.emitted).toEqual([]);
 });
 it("fails reconnect closed after revocation",async () => {
  const f=setup();await f.connection.update([key],[]);f.revoke();await expect(f.connection.update([key],[])).rejects.toThrow();
  expect(f.service.openForView).toHaveBeenCalledTimes(1);
 });
});
