import assert from "node:assert/strict";

// This harness is intentionally unusable with the application's normal DATABASE_URL.
const testUrl = process.env.CONVERSATION_ACCESS_TEST_DATABASE_URL;
if (!testUrl) {throw new Error("A disposable conversation-access test database is required");}
const target = new URL(testUrl);
if (target.pathname !== "/reb559_access_test" || !target.searchParams.get("host")?.includes("/reb559-pg-")) {throw new Error("Refusing non-test database");}
process.env.DATABASE_URL = testUrl;

async function main() {
 const { queryPg, pgPool } = await import("../lib/postgres");
 const { authorizeAccess, registerConversation, changeSharing, tombstoneConversation } = await import("../lib/conversation-access");
 const { conversationKey } = await import("../lib/hermes-conversations");
 const owner={id:"00000000-0000-0000-0000-000000000001",email:"owner@example.test",displayName:"Owner"};
 const other={id:"00000000-0000-0000-0000-000000000002",email:"other@example.test",displayName:"Other"};
 try {
  await queryPg("insert into crm_users values($1),($2) on conflict do nothing",[owner.id,other.id]);
  const key=conversationKey("solo","module-private","agent");
  assert.equal((await registerConversation(owner,key)).visibility,"private");
  await assert.rejects(authorizeAccess(other,key),{status:404});
  await changeSharing(owner,key,"team");
  const shared=await authorizeAccess(other,key);assert.equal(shared.access.canWrite,true);assert.equal(shared.access.canShare,false);
  await assert.rejects(changeSharing(other,key,"private"),{status:404});
  await assert.rejects(authorizeAccess(other,key,"derive"),{status:404});
  await changeSharing(owner,key,"private");
  // Pass stale UI access deliberately: the INSERT must read current parent visibility atomically.
  const derived=conversationKey("group","module-derived");
  assert.equal((await registerConversation(owner,derived,{...shared.access,ownerId:owner.id},key)).visibility,"private");
  await assert.rejects(authorizeAccess(other,derived),{status:404});
  await tombstoneConversation(owner,key);
  await assert.rejects(authorizeAccess(owner,key),{status:404});
  await assert.rejects(changeSharing(owner,key,"team"),{status:404});
  await assert.rejects(registerConversation(owner,conversationKey("solo","resurrect","agent"),{...shared.access,ownerId:owner.id},key),{status:404});
  const external=conversationKey("solo","module-discord","agent");
  assert.equal((await authorizeAccess(other,external,"read",async()=>"discord")).access.visibility,"team");
  await assert.rejects(authorizeAccess(other,conversationKey("solo","legacy-web","agent"),"read",async()=>"web"),{status:404});
  console.log("Conversation access store integration passed: private/team/derive/revoke/tombstone/external/legacy");
 } finally { await pgPool.end(); }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
