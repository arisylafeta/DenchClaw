import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
vi.hoisted(() => { if (process.env.MAIL_SHARING_TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.MAIL_SHARING_TEST_DATABASE_URL; });
import { queryPg, pgPool } from '../postgres';
import { searchMail, readMailThread, readMailMessage, readMailDraft, listMailDrafts, mailIdentityCounts, listMailFollowups } from './mail';
const enabled = !!process.env.MAIL_SHARING_TEST_DATABASE_URL;
const prefix = `sharing_${Date.now()}`;
let alex: string, ari: string;
describe.skipIf(!enabled)('shared aliases and personal mailbox privacy', () => {
 beforeAll(async () => {
  for (const key of ['alex','ari','supply','support','hello','enterprise']) await queryPg(`insert into mail_identity(key,address,display_name,gmail_account) values($1,$2,$1,'alex@rebattery.io') on conflict(key) do nothing`,[key,`${key}@rebattery.io`]);
  for (const key of ['alex','ari']) await queryPg(`insert into crm_users(email,display_name,password_hash) values($1,$1,'fixture-only') on conflict(email) do nothing`,[`${key}@rebattery.io`]);
  alex=(await queryPg<{id:string}>(`select id from crm_users where email='alex@rebattery.io'`))[0].id;
  ari=(await queryPg<{id:string}>(`select id from crm_users where email='ari@rebattery.io'`))[0].id;
  await queryPg(`insert into mail_thread(id,subject,mailbox_owner_id,crm_visible) values($1,'Team conversation',$2,true),($1||'_private','Personal conversation',null,true)`,[prefix,alex]);
  for (const key of ['supply','support','hello','enterprise']) await queryPg(`insert into mail_message(id,identity_key,mailbox_owner_id,thread_id,direction,transport,purpose,state,from_email,to_emails,crm_visible,body_text,sent_at) values($1,$2,$3,$4,'outbound','gmail','personal','accepted',$5,array['buyer@example.test'],true,'team body','2026-01-01')`,[`${prefix}_${key}`,key,alex,prefix,`${key}@rebattery.io`]);
  for (const key of ['alex','ari']) await queryPg(`insert into mail_message(id,identity_key,thread_id,direction,transport,purpose,state,from_email,to_emails,labels,crm_visible,body_text,sent_at) values($1,$2,$3,'outbound','gmail','personal','accepted',$4,array['buyer@example.test'],array['shared'],true,'private body','2026-01-02')`,[`${prefix}_${key}`,key,`${prefix}_private`,`${key}@rebattery.io`]);
  await queryPg(`insert into mail_message(id,identity_key,mailbox_owner_id,thread_id,direction,transport,purpose,state,from_email,to_emails,labels,crm_visible,body_text,sent_at) values($1,'alex',$2,$3,'outbound','gmail','personal','draft','alex@rebattery.io',array['buyer@example.test'],array['shared'],true,'private draft','2026-01-03'),($1||'_team','supply',$4,$5,'outbound','gmail','personal','draft','supply@rebattery.io',array['buyer@example.test'],'{}',true,'shared draft','2026-01-03')`,[`${prefix}_draft`,ari,`${prefix}_private`,alex,prefix]);
  await queryPg(`insert into mail_message(id,thread_id,direction,transport,state,from_email,to_emails,labels,crm_visible,sent_at) values($1,$2,'inbound','gmail','received','buyer@example.test',array['alex@rebattery.io'],array['shared'],true,'2026-01-01')`,[`${prefix}_unclassified`,`${prefix}_private`]);
  await queryPg(`insert into mail_followup(id,message_id,identity_key,due_at,origin) values($1,$2,'supply',now(),'commitment')`,[`${prefix}_followup`,`${prefix}_supply`]);
  await queryPg(`insert into mail_followup(id,thread_id,identity_key,due_at,origin,note) values($1,$2,'alex',now(),'commitment','Private Alex followup')`,[`${prefix}_personal_followup`,`${prefix}_private`]);
 });
 afterAll(async () => { await queryPg(`delete from mail_followup where id like $1`,[`${prefix}%`]);await queryPg(`delete from mail_message where id like $1`,[`${prefix}%`]);await queryPg(`delete from mail_thread where id like $1`,[`${prefix}%`]);await pgPool.end(); });
 it('shares every team alias across owners in lists, counts and message details',async () => {
  for(const key of ['supply','support','hello','enterprise']) {
   expect((await searchMail({mailboxOwnerId:ari,identity:key})).items.map(m=>m.id)).toContain(`${prefix}_${key}`);
   expect((await mailIdentityCounts({mailboxOwnerId:ari})).find(r=>r.identity_key===key)?.count).toBeGreaterThan(0);
   expect(await readMailMessage(`${prefix}_${key}`,ari)).not.toBeNull();
  }
 });
 it('never shares personal identities based on stale shared labels or incorrect ownership',async () => {
  expect((await searchMail({mailboxOwnerId:ari,identity:'alex',showInternal:true})).items).toEqual([]);
  expect((await searchMail({mailboxOwnerId:alex,identity:'ari',showInternal:true})).items).toEqual([]);
  expect(await readMailMessage(`${prefix}_alex`,ari)).toBeNull();
  expect(await readMailMessage(`${prefix}_ari`,alex)).toBeNull();
  expect(await readMailDraft(`${prefix}_draft`,ari)).toBeNull();
  expect((await listMailDrafts(ari)).map(m=>m.id)).not.toContain(`${prefix}_draft`);
  expect((await listMailDrafts(ari)).map(m=>m.id)).toContain(`${prefix}_draft_team`);
  expect((await searchMail({mailboxOwnerId:alex,identity:'alex'})).items.map(m=>m.id)).toContain(`${prefix}_alex`);
 });
 it('opens shared threads but returns only authorized siblings from mixed personal threads',async () => {
  expect((await readMailThread(prefix,ari))?.messages.map(m=>m.id)).toContain(`${prefix}_supply`);
  const a=await readMailThread(`${prefix}_private`,ari);
  expect(a?.messages.map(m=>m.id)).toEqual([`${prefix}_ari`]);
  expect((await readMailThread(`${prefix}_private`,alex))?.messages.map(m=>m.id)).toContain(`${prefix}_unclassified`);
 });
 it('includes shared alias followups for both users',async () => {
  expect((await listMailFollowups(ari,false,{identity:'supply'})).map(m=>m.id)).toContain(`${prefix}_followup`);
 });
 it('never exposes a personal thread followup through a visible sibling',async () => {
  for (const filters of [{}, {identity:'alex'}]) expect((await listMailFollowups(ari,false,filters)).map(m=>m.id)).not.toContain(`${prefix}_personal_followup`);
  expect((await listMailFollowups(alex,false,{identity:'alex'})).map(m=>m.id)).toContain(`${prefix}_personal_followup`);
 });
});
