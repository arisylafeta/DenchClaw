-- buy@rebattery.io (created 7 Nov 2026): the buyer-facing inbox, beside supply@ for sellers. It is a send-as identity on
-- Alex's Gmail like supply@, so its mail reaches Relay and Relay can reply as buy@.
begin;
insert into mail_identity (key, address, display_name, gmail_account, postmark_stream, signature_text, allowed_purposes)
values ('buy', 'buy@rebattery.io', 'Buy @ ReBattery', 'alex@rebattery.io', null, null, array['personal','transactional'])
on conflict (key) do nothing;
commit;
