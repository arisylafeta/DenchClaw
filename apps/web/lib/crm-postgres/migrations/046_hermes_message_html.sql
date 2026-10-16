-- CRM-side mention markup; Hermes remains the authority for message text.
create table if not exists hermes_message_html (
  profile text not null,
  stored_session_id text not null,
  client_message_id text not null,
  text_hash text not null,
  html text not null,
  created_at timestamptz not null default now(),
  primary key (profile, stored_session_id, client_message_id)
);
