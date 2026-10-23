import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./postgres", () => ({ queryPg: vi.fn() }));
vi.mock("./auth", () => ({ ALLOWED_EMAILS: new Set(["admin@example.test"]) }));
import { queryPg } from "./postgres";
import { accessFor, authorizeAccess, canonicalIdentity, registerConversation, changeSharing, tombstoneConversation, assertSafePrompt } from "./conversation-access";
import { conversationKey } from "./hermes-conversations";
const owner = { id: "owner", email: "owner@example.test", displayName: "Owner" };
const other = { id: "other", email: "other@example.test", displayName: "Other" };
const admin = { ...other, email: "admin@example.test" };
const key = conversationKey("solo","stored","agent");
const row = { creator_id: owner.id, owner_id: owner.id, origin: "crm", visibility: "private" as const, version: 1, deleted_at: null };
beforeEach(() => { vi.mocked(queryPg).mockReset(); });
describe("durable conversation policy", () => {
 it("denies private reads including administrators, and unknown actors",async () => {
  expect(() => accessFor(row,other)).toThrow("not_found"); expect(() => accessFor(row,admin)).toThrow("not_found");
  await expect(authorizeAccess(undefined,key)).rejects.toMatchObject({status:401}); expect(queryPg).not.toHaveBeenCalled();
 });
 it("separates participation, ownership and privileged approval",() => {
  const shared = {...row,visibility:"team" as const};
  expect(accessFor(shared,other)).toMatchObject({canWrite:true,canShare:false,canDelete:false,canApprove:false});
  for(const action of ["derive","share","delete","approve"] as const) expect(() => accessFor(shared,other,action)).toThrow("not_found");
  expect(accessFor(shared,admin,"approve").canApprove).toBe(true);
  expect(accessFor(row,owner,"share").canShare).toBe(true);
 });
 it("never resurrects deleted externally sourced rows",async () => {
  vi.mocked(queryPg).mockResolvedValue([{...row,origin:"discord",visibility:"team",deleted_at:"yesterday"}]);
  const source = vi.fn(async () => "discord");
  await expect(authorizeAccess(other,key,"read",source)).rejects.toMatchObject({status:404}); expect(source).not.toHaveBeenCalled();
 });
 it.each(["web","crm","api_server","desktop","unknown",undefined])("does not infer ownership or sharing from %s",async source => {
  vi.mocked(queryPg).mockResolvedValue([]);
  await expect(authorizeAccess(admin,key,"read",async () => source)).rejects.toMatchObject({status:404});
  expect(queryPg).toHaveBeenCalledTimes(1);
 });
 it("registers only server verified external sessions and rereads the winner",async () => {
  vi.mocked(queryPg).mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([{...row,owner_id:null,creator_id:null,origin:"discord",visibility:"team"}]);
  expect((await authorizeAccess(other,key,"read",async () => "discord")).access).toMatchObject({ownerId:null,visibility:"team",canShare:false});
 });
 it("has fixed failure responses without storage details",async () => {
  vi.mocked(queryPg).mockImplementation(() => { throw new Error("database detail"); });
  let failure: unknown;
  try { await authorizeAccess(owner,key); } catch(error) { failure = error; }
  vi.mocked(queryPg).mockReset();
  expect(failure).toMatchObject({status:503,message:"conversation_access_unavailable"});
 });
 it("rejects aliases and nonempty group profiles",() => {
  expect(() => canonicalIdentity(encodeURIComponent(JSON.stringify(["group","alias","room"])))).toThrow("not_found");
  expect(() => canonicalIdentity(decodeURIComponent(key))).toThrow("not_found");
 });
 it("registers new private chats, preserves inherited access, and rejects foreign derivation",async () => {
  vi.mocked(queryPg).mockResolvedValue([row]);
  expect(await registerConversation(owner,key)).toMatchObject({ownerId:owner.id,visibility:"private"});
  expect(vi.mocked(queryPg).mock.calls[0][1]).toEqual(["solo","agent","stored",owner.id,"private"]);
  await expect(registerConversation(other,key,accessFor(row,owner))).rejects.toMatchObject({status:404});
 });
 it("cannot share or delete another owner's shared chat",async () => {
  vi.mocked(queryPg).mockResolvedValue([{...row,visibility:"team"}]);
  await expect(changeSharing(other,key,"private")).rejects.toMatchObject({status:404});
  await expect(tombstoneConversation(other,key)).rejects.toMatchObject({status:404});
  expect(queryPg).toHaveBeenCalledTimes(2);
 });
 it("blocks non-admin host context and attachment paths",() => {
  expect(() => assertSafePrompt(other,{text:"see /root/private.png"})).toThrow();
  expect(() => assertSafePrompt(other,{text:"hi",context:{filePath:"private"}})).toThrow();
  expect(() => assertSafePrompt(other,{text:"hello"})).not.toThrow();
 });
});
