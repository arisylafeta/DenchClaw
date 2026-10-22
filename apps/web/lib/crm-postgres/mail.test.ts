import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
vi.hoisted(() => { if (process.env.BULK_TRADES_TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.BULK_TRADES_TEST_DATABASE_URL; });
import { queryPg, pgPool } from '../postgres';
import { searchMail, readMailThread, listMailFollowups, mailCampaignCounts, readMailCampaign, listMailCampaigns } from './mail';
import { getPostgresObjectData } from './object-read';
import { getPostgresEntryData } from './entry-read';
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
  await queryPg(`insert into mail_thread(id,subject,mailbox_owner_id,crm_visible) values ($1||'_paging','Second conversation',$2,true)`,[prefix,owner]);
  await queryPg(`insert into mail_message(id,direction,transport,purpose,state,thread_id,mailbox_owner_id,crm_visible,subject,from_email,body_text,sent_at) values
   ($1||'_a','inbound','gmail',null,'received',$1,$2,true,'Battery reply','buyer@example.test','packs','2026-01-01T10:00:00Z'),
   ($1||'_b','inbound','gmail',null,'received',$1,$2,false,'Private note','private@example.test','private','2026-01-01T10:00:00Z')`,[prefix,owner]);
  await queryPg(`insert into mail_message(id,direction,transport,purpose,state,campaign_id,mailbox_owner_id,recipient_email,accepted_at,delivered_at,opened_at,clicked_at,bounced_at) values
   ($1||'_c','outbound','postmark-broadcast','marketing','accepted',$1,$2,'one@example.test',now(),now(),now(),now(),null),
   ($1||'_d','outbound','postmark-broadcast','marketing','accepted',$1,$2,'two@example.test',now(),null,null,null,now())`,[prefix,owner]);
  await queryPg(`update mail_message set campaign_id=$1 where id=$1||'_a'`,[prefix]);
  await queryPg(`insert into mail_thread(id,subject,mailbox_owner_id,crm_visible) values ($1||'_bulk','Bulk campaign',$2,true)`,[prefix,owner]);
  await queryPg(`update mail_message set thread_id=$1||'_bulk',crm_visible=true where id=$1||'_c'`,[prefix]);
  await queryPg(`insert into mail_event(message_id,type,source,occurred_at,detail) values ($1||'_a','replied','gmail',now(),'{}'),($1||'_c','unsubscribed','postmark',now(),'{"scanner":true}'),($1||'_c','replied','gmail',now(),'{}')`,[prefix]);
  await queryPg(`insert into mail_followup(id,message_id,due_at,origin) values ($1,$1||'_a',now()-interval '1 day','commitment')`,[prefix]);
 });
 afterAll(async () => { await queryPg('delete from mail_followup where id=$1',[prefix]); await queryPg('delete from mail_message where id like $1',[`${prefix}%`]); await queryPg('delete from mail_thread where id like $1',[`${prefix}%`]); await queryPg('delete from campaigns where id=$1',[prefix]); await queryPg('delete from crm_users where id=$1',[owner]); await pgPool.end(); });
 it('excludes bulk deliveries but retains inbound campaign replies and filters the CRM subset',async () => {
  const all=await searchMail({mailboxOwnerId:owner,view:'conversations'}); expect(all.items.map(m=>m.id)).toEqual([`${prefix}_b`]); expect(all.items[0].message_count).toBe(2);
  const crm=await searchMail({mailboxOwnerId:owner,crmOnly:true}); expect(crm.items.map(m=>m.id).sort()).toEqual([`${prefix}_a`,`${prefix}_c`]);
 });
 it('keeps campaigns visible in CRM-only lists and Sent without changing visibility flags',async () => {
  expect((await listMailCampaigns({crmOnly:true})).some(c=>c.id===prefix)).toBe(true);
  expect((await readMailCampaign(prefix,{crmOnly:true}))?.counts.total).toBe(2);
  expect((await searchMail({mailboxOwnerId:owner,view:'sent',crmOnly:true})).items.map(m=>m.id).sort()).toEqual([`${prefix}_c`,`${prefix}_d`]);
  expect((await queryPg<{crm_visible:boolean}>('select crm_visible from mail_message where id=$1',[`${prefix}_d`]))[0].crm_visible).toBe(false);
 });
 it('returns one latest row per inbound thread, real counts and participants, and no list bodies',async () => {
  await queryPg(`insert into mail_message(id,thread_id,mailbox_owner_id,direction,transport,purpose,state,crm_visible,from_email,to_emails,subject,body_text,sent_at)
    values ($1||'_latest',$1,$2,'outbound','gmail','personal','accepted',true,'alex@rebattery.io',array['buyer@example.test'],'Latest reply','Full reply body','2026-01-02'),
      ($1||'_blast',$1||'_bulk',$2,'outbound','gmail','marketing','accepted',true,'alex@rebattery.io',array['buyer@example.test'],'Unlinked Gmail bulk send','Bulk body','2026-01-03')`,[prefix,owner]);
  try {
   await queryPg('update mail_message set body_html=$2 where id=$1',[`${prefix}_latest`,'<p>HTML reply body</p>']);
   const page=await searchMail({mailboxOwnerId:owner,view:'conversations',limit:1});
   expect(page.items).toHaveLength(1); expect(page.nextCursor).toBeNull();
   expect(page.items[0]).toMatchObject({id:`${prefix}_latest`,thread_id:prefix,message_count:3,subject:'Latest reply'});
   expect(page.items[0].participants).toEqual(expect.arrayContaining([expect.objectContaining({email:'alex@rebattery.io',is_self:true}),expect.objectContaining({email:'buyer@example.test',is_self:false})]));
   for (const view of ['conversations','sent'] as const) {
    const rows=(await searchMail({mailboxOwnerId:owner,view})).items;
    for(const row of rows){expect(row).not.toHaveProperty('body_text');expect(row).not.toHaveProperty('body_html');}
   }
   expect((await readMailThread(prefix,owner))?.messages.at(-1)?.body_text).toBe('Full reply body');
   expect((await readMailThread(prefix,owner))?.messages.at(-1)?.body_html).toBe('<p>HTML reply body</p>');
  } finally {await queryPg('delete from mail_message where id=any($1)',[[`${prefix}_latest`,`${prefix}_blast`]]);}
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
 it('hides rebattery.io to rebattery.io mail unless asked, keeping mixed recipients',async () => {
  await queryPg(`insert into mail_message(id,direction,transport,purpose,state,mailbox_owner_id,from_email,to_emails,cc_emails,sent_at) values
   ($1||'_int','outbound','gmail','personal','accepted',$2,'alex@rebattery.io','{ari@rebattery.io}','{}','2026-02-01T10:00:00Z'),
   ($1||'_mix','outbound','gmail','personal','accepted',$2,'alex@rebattery.io','{ari@rebattery.io}','{buyer@example.test}','2026-02-01T11:00:00Z'),
   ($1||'_evil','outbound','gmail','personal','accepted',$2,'alex@rebattery.io','{x@rebattery.io.evil.com}','{}','2026-02-01T12:00:00Z')`,[prefix,owner]);
  const ids=async(showInternal?:boolean)=>(await searchMail({mailboxOwnerId:owner,view:'sent',since:'2026-02-01',showInternal})).items.map(m=>m.id).sort();
  expect(await ids()).toEqual([`${prefix}_evil`,`${prefix}_mix`]);
  expect(await ids(true)).toEqual([`${prefix}_evil`,`${prefix}_int`,`${prefix}_mix`]);
 });
 it('reads ordered thread messages and events without crossing mailbox owners',async () => {
  const thread=await readMailThread(prefix,owner); expect(thread?.messages).toHaveLength(2); expect(thread?.messages[0].events?.[0].type).toBe('replied');
  expect(await readMailThread(prefix,'00000000-0000-0000-0000-000000000000')).toBeNull();
 });
 it('lists due pending follow-ups',async () => { expect((await listMailFollowups(owner,true)).map(f=>f.id)).toEqual([prefix]); });
 it('keeps CRM-visible thread-only follow-ups and applies identity and message filters without duplicates',async () => {
  await queryPg(`insert into mail_followup(id,thread_id,identity_key,due_at,origin,state) values ($1||'_thread',$1,'ari',now()-interval '1 day','commitment','paused')`,[prefix]);
  const scoped=await listMailFollowups(owner,false,{crmOnly:true,identity:'ari',q:'Battery'});
  expect(scoped.map(f=>f.id)).toEqual([`${prefix}_thread`]);
  expect((await listMailFollowups(owner,false,{crmOnly:true,identity:'alex'})).map(f=>f.id)).not.toContain(`${prefix}_thread`);
  expect((await listMailFollowups('00000000-0000-0000-0000-000000000000',false,{crmOnly:true,identity:'ari'}))).toEqual([]);
  await queryPg('delete from mail_followup where id=$1',[`${prefix}_thread`]);
 });
 it('isolates generic mail objects by backing table and CRM visibility',async () => {
  await expect(getPostgresEntryData('mail_message',`${prefix}_b`,owner)).rejects.toThrow('Entry not found');
  await expect(getPostgresEntryData('mail_message',`${prefix}_a`,'00000000-0000-0000-0000-000000000000')).rejects.toThrow('Entry not found');
  const result=await getPostgresObjectData('mail_message',new URL('http://localhost/api/objects/mail_message'),owner);
  const payload=JSON.stringify(result);
  expect(payload).toContain(`${prefix}_a`);expect(payload).not.toContain(`${prefix}_b`);
 });
 it('preserves microseconds in pagination cursors',async () => {
  await queryPg(`update mail_message set thread_id=$1||'_paging' where id=$1||'_b'`,[prefix]);
  await queryPg(`update mail_message set sent_at=case when id=$1||'_b' then '2026-01-01T10:00:00.123900Z'::timestamptz else '2026-01-01T10:00:00.123800Z'::timestamptz end where id in ($1||'_a',$1||'_b')`,[prefix]);
  const first=await searchMail({mailboxOwnerId:owner,view:'conversations',limit:1});
  expect(Buffer.from(first.nextCursor!,'base64url').toString()).toContain('.1239');
  expect((await searchMail({mailboxOwnerId:owner,view:'conversations',limit:1,cursor:first.nextCursor!})).items[0].id).toBe(`${prefix}_a`);
  await queryPg(`update mail_message set sent_at='2026-01-01T10:00:00Z' where id in ($1||'_a',$1||'_b')`,[prefix]);
  await queryPg(`update mail_message set thread_id=$1 where id=$1||'_b'`,[prefix]);
 });
 it('filters campaign counts, recipients, links and scanner evidence together',async () => {
  const detail=await readMailCampaign(prefix,{crmOnly:true,event:'bounced'});
  expect(detail?.counts.total).toBe(1); expect(detail?.delivery_rows.map(row=>row.id)).toEqual([`${prefix}_d`]); expect(detail?.recipients).toHaveLength(1); expect(detail?.links).toEqual([]); expect(detail?.scanner_evidence).toBe(false);
 });
 it('selects external recipients before internal recipients, including cc and CRM names',async () => {
  await queryPg(`insert into crm_people(id,full_name,email) values ($1,'Synthetic counterparty','counterparty@example.test')`,[prefix]);
  try {
   await queryPg(`update mail_message set from_email='admin@rebattery.io',to_emails=array['alex@rebattery.io'],cc_emails=array['counterparty@example.test'] where id=$1||'_a'`,[prefix]);
   expect((await searchMail({mailboxOwnerId:owner,thread:prefix})).items.find(m=>m.id===`${prefix}_a`)?.counterparty).toEqual({email:'counterparty@example.test',name:'Synthetic counterparty'});
   await queryPg(`update mail_message set cc_emails='{}',to_emails=array['ari@rebattery.io','alex@rebattery.io'] where id=$1||'_a'`,[prefix]);
   expect((await readMailThread(prefix,owner))?.messages[0].counterparty?.email).toBe('ari@rebattery.io');
   await queryPg(`update mail_message set from_email=null where id=$1||'_a'`,[prefix]);
   expect((await searchMail({mailboxOwnerId:owner,thread:prefix})).items.find(m=>m.id===`${prefix}_a`)?.counterparty).toBeNull();
  } finally {
   await queryPg(`update mail_message set from_email='buyer@example.test',to_emails='{}',cc_emails='{}' where id=$1||'_a'`,[prefix]);
   await queryPg('delete from crm_people where id=$1',[prefix]);
  }
 });
 it('classifies complete ReBattery domains and configured identities on messages and participants',async () => {
  const addresses = ['admin@rebattery.io','alex@rebattery.io','ANY@ReBattery.IO','x@rebattery.io.evil.com','x@notrebattery.io','buyer@example.test'];
  for (const address of addresses) {
   await queryPg(`update mail_message set from_email=$2 where id=$1||'_a'`,[prefix,address]);
   const page=await searchMail({mailboxOwnerId:owner,from:address});
   expect(page.items[0].is_self).toBe(address.toLowerCase().endsWith('@rebattery.io'));
   expect((await readMailThread(prefix,owner))?.messages[0].is_self).toBe(address.toLowerCase().endsWith('@rebattery.io'));
  }
  const [identity]=await queryPg<{key:string;address:string}>('select key,address from mail_identity order by key limit 1');
  try {
   await queryPg(`update mail_identity set address='configured@example.test' where key=$1`,[identity.key]);
   await queryPg(`update mail_message set from_email='CONFIGURED@example.test' where id=$1||'_a'`,[prefix]);
   expect((await searchMail({mailboxOwnerId:owner,thread:prefix})).items.find(m=>m.id===`${prefix}_a`)?.is_self).toBe(true);
  } finally {
   await queryPg('update mail_identity set address=$2 where key=$1',[identity.key,identity.address]);
  }
  await queryPg(`insert into crm_people(id,full_name,email) values ($1,'Synthetic self','admin@rebattery.io')`,[prefix]);
  await queryPg(`update mail_message set from_person_id=$1 where id=$1||'_a'`,[prefix]);
  expect((await readMailThread(prefix,owner))?.people).toEqual(expect.arrayContaining([expect.objectContaining({id:prefix,is_self:true})]));
  await queryPg(`update mail_message set from_email='buyer@example.test',from_person_id=null where id=$1||'_a'`,[prefix]);
  await queryPg('delete from crm_people where id=$1',[prefix]);
 });
 it('enforces mail ownership with database permissions even for Unicode identifiers',async () => {
  const client=await pgPool.connect();
  try {
   await client.query('begin'); await client.query('set local role crm_agent_sql');
   expect((await client.query('select id from mail_message limit 1')).rows).toHaveLength(1);
   await client.query(`update crm_people set full_name=full_name where false`);
   await expect(client.query(String.raw`update U&"ma\0069l_identity" set active=false where key='ari'`)).rejects.toThrow(/permission denied/);
   await client.query('rollback');
   await client.query('begin'); await client.query('set local role crm_web_sql');
   await expect(client.query(String.raw`select * from U&"ma\0069l_message"`)).rejects.toThrow(/permission denied/);
  } finally { await client.query('rollback');client.release(); }
 });
 it('paginates tied timestamps deterministically without repeats',async () => {
  await queryPg(`update mail_message set thread_id=$1||'_paging' where id=$1||'_b'`,[prefix]);
  const first=await searchMail({mailboxOwnerId:owner,view:'conversations',limit:1});
  const second=await searchMail({mailboxOwnerId:owner,view:'conversations',limit:1,cursor:first.nextCursor!});
  expect(first.items[0].id).toBe(`${prefix}_b`); expect(second.items[0].id).toBe(`${prefix}_a`); expect(second.nextCursor).toBeNull();
  await expect(searchMail({cursor:'not-json'})).rejects.toThrow('invalid_cursor');
  await queryPg(`update mail_message set thread_id=$1 where id=$1||'_b'`,[prefix]);
 });

  it('shows ownerless mail labelled shared to every user under All, and no other ownerless mail', async () => {
    const id = `${prefix}_shared`;
    const [user] = await queryPg<{ id: string }>(`insert into crm_users(email,display_name,password_hash) values ($1,'Shared reader','x') returning id`, [`${id}@example.test`]);
    await queryPg(`insert into mail_thread(id,subject,mailbox_owner_id,crm_visible) values ($1,'Legacy alias mail',null,true)`, [id]);
    await queryPg(`insert into mail_message(id,direction,transport,purpose,state,thread_id,mailbox_owner_id,crm_visible,subject,from_email,to_emails,body_text,sent_at,labels) values
      ($1||'_in','inbound','gmail',null,'received',$1,null,true,'Legacy alias mail','seller@example.test',array['sales@rebattery.io'],'Packs for sale','2024-07-01T10:00:00Z',array['shared']),
      ($1||'_other','inbound','gmail',null,'received',$1,null,true,'Ownerless, not shared','other@example.test',array['x@rebattery.io'],'Hidden','2024-07-02T10:00:00Z','{}')`, [id]);
    const found = (await searchMail({ mailboxOwnerId: user.id, thread: id })).items.map((m) => m.id);
    expect(found).toEqual([`${id}_in`]);
    expect((await readMailThread(id, user.id))?.messages.map((m) => m.id)).toEqual([`${id}_in`]);
    await queryPg('delete from mail_message where id like $1', [`${id}%`]); await queryPg('delete from mail_thread where id = $1', [id]);
    await queryPg('delete from crm_users where id = $1', [user.id]);
  });
});
