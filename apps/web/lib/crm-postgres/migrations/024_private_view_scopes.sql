-- Private-object saved filters must not expose mailbox or task metadata to other users.
create table if not exists crm_private_object_views (
  like crm_object_views including defaults including constraints,
  user_id uuid not null,
  primary key (object_id, user_id),
  foreign key (object_id) references crm_objects(id) on delete cascade
);
