import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
vi.hoisted(() => { if (process.env.BULK_TRADES_TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.BULK_TRADES_TEST_DATABASE_URL; });
import { queryPg, pgPool } from '../postgres';
import { searchMail, readMailThread, listMailFollowups, mailCampaignCounts, readMailCampaign } from './mail';
import { getPostgresInbox } from './inbox';
import { getPostgresInboxThread } from './inbox-thread';
const enabled = Boolean(process.env.BULK_TRADES_TEST_DATABASE_URL);
const prefix = `mail_web_${Date.now()}`;
let owner: string;
describe.skipIf(!enabled)('unified mail log', () => {
 beforeAll(async () => {
  const [user] = await queryPg<{id:string}>(`insert into crm_users(email,display_name,password_hash) values ($1,'Synthetic mail','x') returning id`,[`${prefix}@example.test`]); owner=user.id;
  await queryPg(`insert into campaigns(id,campaign_name) values ($1,'Synthetic mail campaign')`,[prefix]);
  await queryPg(`insert into mail_thread(id,subject,mailbox_owner_id,crm_visible) values ($1,'Battery reply',$2,true)`,[prefix,owner]);
  await queryPg(`insert into mail_message(id,direction,transport,purpose,state,thread_id,mailbox_owner_id,crm_visible,subject,from_email,body_text,sent_at) values
   ($1||'_a','inbound','gmail',null,'received',$1,$2,true,'Battery reply','buyer@example.test','packs','2026-01-01T10:00:00Z'),
   ($1||'_b','inbound','gmail',null,'received',$1,$2,false,'Private note','private@example.test','private','2026-01-01T10:00:00Z')`,[prefix,owner]);
  await queryPg(`insert into mail_message(id,direction,transport,purpose,state,campaign_id,mailbox_owner_id,recipient_email,accepted_at,delivered_at,opened_at,clicked_at,bounced_at) values
   ($1||'_c','outbound','postmark-broadcast','marketing','accepted',$1,$2,'one@example.test',now(),now(),now(),now(),null),
   ($1||'_d','outbound','postmark-broadcast','marketing','accepted',$1,$2,'two@example.test',now(),null,null,null,now())`,[prefix,owner]);
  await queryPg(`insert into mail_thread(id,subject,mailbox_owner_id,crm_visible) values ($1||'_bulk','Bulk campaign',$2,true)`,[prefix,owner]);
  await queryPg(`update mail_message set thread_id=$1||'_bulk',crm_visible=true where id=$1||'_c'`,[prefix]);
  await queryPg(`insert into mail_event(message_id,type,source,occurred_at,detail) values ($1||'_a','replied','gmail',now(),'{}'),($1||'_c','unsubscribed','postmark',now(),'{"scanner":true}'),($1||'_c','replied','gmail',now(),'{}')`,[prefix]);
  await queryPg(`insert into mail_followup(id,message_id,due_at,origin) values ($1,$1||'_a',now()-interval '1 day','commitment')`,[prefix]);
 });
 afterAll(async () => { await queryPg('delete from mail_followup where id=$1',[prefix]); await queryPg('delete from mail_message where id like $1',[`${prefix}%`]); await queryPg('delete from mail_thread where id like $1',[`${prefix}%`]); await queryPg('delete from campaigns where id=$1',[prefix]); await queryPg('delete from crm_users where id=$1',[owner]); await pgPool.end(); });
 it('excludes bulk delivery rows from conversations and filters the CRM subset',async () => {
  const all=await searchMail({mailboxOwnerId:owner,view:'conversations'}); expect(all.items.map(m=>m.id).sort()).toEqual([`${prefix}_a`,`${prefix}_b`]);
  const crm=await searchMail({mailboxOwnerId:owner,crmOnly:true}); expect(crm.items.map(m=>m.id).sort()).toEqual([`${prefix}_a`,`${prefix}_c`]);
 });
 it('keeps the CRM inbox campaign-free and reads only visible thread messages',async () => {
  const inbox=await getPostgresInbox({search:'',senderFilter:'all',personId:null,limit:50,offset:0},owner);
  expect(inbox.threads.map(thread=>thread.id)).toEqual([prefix]);
  expect((await getPostgresInboxThread(prefix,owner))?.messages).toHaveLength(1);
 });
 it('keeps all seven campaign counts separate',async () => {
  const [counts]=await mailCampaignCounts(prefix); expect(counts).toMatchObject({sent:2,delivered:1,bounced:1,opened:1,clicked:1,unsubscribed:1,replied:1,total:2});
  expect(await readMailCampaign(prefix)).toMatchObject({scanner_evidence:true,proxy_evidence:false,counts:{sent:2}});
 });
 it('applies search identity, recipient, purpose, state, event and time filters',async () => {
  const result=await searchMail({mailboxOwnerId:owner,q:'Battery',from:'buyer@example.test',direction:'inbound',transport:'gmail',state:'received',event:'replied',since:'2026-01-01',until:'2026-01-02'});
  expect(result.items.map(m=>m.id)).toEqual([`${prefix}_a`]);
  expect((await searchMail({mailboxOwnerId:owner,campaign:prefix,purpose:'marketing',to:'one@example.test'})).items.map(m=>m.id)).toEqual([`${prefix}_c`]);
  expect((await searchMail({mailboxOwnerId:owner,identity:'ari'})).items).toEqual([]);
 });
 it('reads ordered thread messages and events without crossing mailbox owners',async () => {
  const thread=await readMailThread(prefix,owner); expect(thread?.messages).toHaveLength(2); expect(thread?.messages[0].events?.[0].type).toBe('replied');
  expect(await readMailThread(prefix,'00000000-0000-0000-0000-000000000000')).toBeNull();
 });
 it('lists due pending follow-ups',async () => { expect((await listMailFollowups(owner,true)).map(f=>f.id)).toEqual([prefix]); });
 it('paginates tied timestamps deterministically without repeats',async () => {
  const first=await searchMail({mailboxOwnerId:owner,view:'conversations',limit:1});
  const second=await searchMail({mailboxOwnerId:owner,view:'conversations',limit:1,cursor:first.nextCursor!});
  expect(first.items[0].id).toBe(`${prefix}_b`); expect(second.items[0].id).toBe(`${prefix}_a`); expect(second.nextCursor).toBeNull();
  await expect(searchMail({cursor:'not-json'})).rejects.toThrow('invalid_cursor');
 });
});
