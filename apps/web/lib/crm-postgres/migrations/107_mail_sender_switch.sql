-- Relay sender switch: a draft's sender can change between alex@, supply@, buy@ and hello@, all through Alex's Gmail.
--
-- auto_sign: supply@ sends thousands of templated broadcasts and automated notices that must stay unsigned, so its
-- signature (and buy@'s) is added only where a person writes one-to-one: a draft made with --sign, or a draft whose
-- sender is switched to it. Every other identity keeps signing as before.
--
-- hello@ gets a Gmail account so Relay can send as it. Its default transport stays Postmark.
-- Gmail only sends as an address that is a "Send mail as" alias on the account; the mail tool checks that before a send.
begin;
alter table mail_identity add column if not exists auto_sign boolean not null default true;
update mail_identity set auto_sign = false where key in ('supply', 'buy');
update mail_identity set signature_text = $sig$Alex Polglase
Supply
rebattery.io | supply@rebattery.io
$sig$,
  signature_html = $sig$<div dir="ltr"><table style="color:rgb(0,0,0);font-family:Geist,system-ui,sans-serif;border-collapse:collapse;border-spacing:0px"><tbody><tr><td style="padding-right:20px;vertical-align:middle;white-space:nowrap"><br><img src="https://www.rebattery.io/rebattery-logo-all-black.png" width="96" height="16"><br><br></td><td style="border-left-width:1px;border-left-style:solid;border-left-color:rgb(230,229,224);padding-left:20px;vertical-align:top"><div style="font-size:14px;font-weight:600;letter-spacing:-0.01em;color:rgb(22,22,26);margin-bottom:2px">Alex Polglase</div><div style="font-family:&quot;Geist Mono&quot;,monospace;font-size:9.5px;letter-spacing:0.13em;text-transform:uppercase;color:rgb(138,138,143);margin-bottom:9px">SUPPLY</div><div><a href="https://rebattery.io/" style="color:rgb(86,86,91);text-decoration:none;font-size:11.5px" target="_blank">rebattery.io</a><span style="color:rgb(204,202,195);font-size:8px">  ●  <a href="mailto:supply@rebattery.io" style="color:rgb(86,86,91);text-decoration:none;font-size:11.5px;display:inline!important" target="_blank">supply@rebattery.io</a></span></div></td></tr></tbody></table></div>$sig$, updated_at = now() where key = 'supply';
update mail_identity set signature_text = $sig$Alex Polglase
Sourcing
rebattery.io | buy@rebattery.io
$sig$,
  signature_html = $sig$<div dir="ltr"><table style="color:rgb(0,0,0);font-family:Geist,system-ui,sans-serif;border-collapse:collapse;border-spacing:0px"><tbody><tr><td style="padding-right:20px;vertical-align:middle;white-space:nowrap"><br><img src="https://www.rebattery.io/rebattery-logo-all-black.png" width="96" height="16"><br><br></td><td style="border-left-width:1px;border-left-style:solid;border-left-color:rgb(230,229,224);padding-left:20px;vertical-align:top"><div style="font-size:14px;font-weight:600;letter-spacing:-0.01em;color:rgb(22,22,26);margin-bottom:2px">Alex Polglase</div><div style="font-family:&quot;Geist Mono&quot;,monospace;font-size:9.5px;letter-spacing:0.13em;text-transform:uppercase;color:rgb(138,138,143);margin-bottom:9px">SOURCING</div><div><a href="https://rebattery.io/" style="color:rgb(86,86,91);text-decoration:none;font-size:11.5px" target="_blank">rebattery.io</a><span style="color:rgb(204,202,195);font-size:8px">  ●  <a href="mailto:buy@rebattery.io" style="color:rgb(86,86,91);text-decoration:none;font-size:11.5px;display:inline!important" target="_blank">buy@rebattery.io</a></span></div></td></tr></tbody></table></div>$sig$, updated_at = now() where key = 'buy';
update mail_identity set gmail_account = 'alex@rebattery.io', updated_at = now() where key = 'hello' and gmail_account is null;
commit;
