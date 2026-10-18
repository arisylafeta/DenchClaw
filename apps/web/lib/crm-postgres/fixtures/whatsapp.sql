-- Synthetic local acceptance fixture only. Load after schema and migrations.
insert into crm_companies(id,name) values('wa-fixture-company','Synthetic Battery Works');
insert into crm_people(id,full_name,email,company_id,phone) values
 ('wa-fixture-person','Synthetic Buyer','buyer@example.test','wa-fixture-company','+447700900001'),
 ('wa-fixture-proposal','Synthetic Contact','contact@example.test',null,'+447700900002');
insert into whatsapp_account(id,account_jid,metadata) values('wa-fixture-account','synthetic-account@s.whatsapp.net',
 '{"capture_status":{"state":"disconnected","gapSince":"2026-10-18T09:00:00Z","lastGap":{"from":"2026-10-17T10:00:00Z","to":"2026-10-17T10:15:00Z"}}}');
insert into whatsapp_identity(id,account_id,canonical_jid,e164,display_name) values
 ('wa-fixture-linked','wa-fixture-account','synthetic-linked@s.whatsapp.net','+447700900001','Synthetic Buyer'),
 ('wa-fixture-unknown','wa-fixture-account','synthetic-unknown@lid',null,null),
 ('wa-fixture-unmatched','wa-fixture-account','synthetic-unmatched@s.whatsapp.net','+447700900002','Synthetic Contact');
insert into whatsapp_identity_link(id,account_id,identity_id,person_id,method,confidence,evidence,actor) values
 ('wa-fixture-link','wa-fixture-account','wa-fixture-linked','wa-fixture-person','manual','confirmed','{}','synthetic-operator');
insert into whatsapp_thread(id,account_id,canonical_chat_id,identity_id,kind,subject,first_captured_at,last_captured_at) values
 ('wa-fixture-direct','wa-fixture-account','synthetic-direct','wa-fixture-linked','direct','Synthetic 1:1 battery enquiry',now(),now()),
 ('wa-fixture-group','wa-fixture-account','synthetic-group@g.us',null,'group','Synthetic battery sourcing group',now(),now());
insert into whatsapp_thread_member(account_id,thread_id,identity_id,first_observed_at,last_observed_at) values
 ('wa-fixture-account','wa-fixture-group','wa-fixture-linked',now(),now()),
 ('wa-fixture-account','wa-fixture-group','wa-fixture-unknown',now(),now());
insert into whatsapp_message(id,account_id,thread_id,provider_message_id,sender_identity_id,direction,occurred_at,captured_at,timestamp_source,body,original_seen) values
 ('wa-fixture-message','wa-fixture-account','wa-fixture-direct','fixture-direct-message','wa-fixture-linked','inbound','2026-10-18 08:00Z','2026-10-18 08:00Z','provider','Synthetic fixture: looking for battery modules for a stationary project.',true),
 ('wa-fixture-group-first','wa-fixture-account','wa-fixture-group','fixture-first','wa-fixture-linked','inbound','2026-10-18 08:01Z','2026-10-18 08:01Z','provider','Synthetic fixture: please share module specifications.',true),
 ('wa-fixture-group-reply','wa-fixture-account','wa-fixture-group','fixture-reply','wa-fixture-unknown','inbound','2026-10-18 08:02Z','2026-10-18 08:02Z','provider','Synthetic fixture: revised module quantities available next week.',true),
 ('wa-fixture-group-media','wa-fixture-account','wa-fixture-group','fixture-media','wa-fixture-unknown','inbound',null,'2026-10-18 08:03Z','capture',null,true),
 ('wa-fixture-group-deleted','wa-fixture-account','wa-fixture-group','fixture-deleted','wa-fixture-linked','inbound','2026-10-18 08:04Z','2026-10-18 08:04Z','provider',null,true);
update whatsapp_message set reply_to_provider_id='fixture-first',reply_to_message_id='wa-fixture-group-first',edit_version=1 where id='wa-fixture-group-reply';
update whatsapp_message set attachment='{"type":"audio","mimetype":"audio/ogg"}',metadata='{"expiry_policy_unavailable":true}' where id='wa-fixture-group-media';
update whatsapp_message set deleted_at='2026-10-18 08:05Z' where id='wa-fixture-group-deleted';
insert into crm_bulk_trade_lots(id,title,lot_kind,summary,observed_outcome,confidence) values
 ('wa-fixture-trade','Synthetic module trade','supply','Synthetic WhatsApp evidence fixture','unknown','confirmed');
