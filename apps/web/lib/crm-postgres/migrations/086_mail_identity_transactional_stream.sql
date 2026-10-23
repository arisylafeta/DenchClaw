-- REB-562: an identity can send transactional mail through Postmark while its other mail stays on Gmail.
begin;
alter table mail_identity add column if not exists transactional_postmark_stream text;
update mail_identity set transactional_postmark_stream = 'outbound' where key = 'supply' and transactional_postmark_stream is null;
commit;
