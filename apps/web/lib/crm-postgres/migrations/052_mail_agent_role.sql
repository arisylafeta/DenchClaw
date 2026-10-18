begin;
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'crm_agent_sql') then create role crm_agent_sql nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'crm_web_sql') then create role crm_web_sql nologin; end if;
end $$;
grant usage on schema public to crm_agent_sql, crm_web_sql;
grant select on all tables in schema public to crm_agent_sql, crm_web_sql;
grant insert,update,delete on all tables in schema public to crm_agent_sql;
grant usage,select on all sequences in schema public to crm_agent_sql;
do $$ declare item record; begin
  for item in select tablename from pg_tables where schemaname='public' and tablename like 'mail\_%' escape '\'
  loop
    execute format('revoke insert,update,delete,truncate,references,trigger on public.%I from crm_agent_sql',item.tablename);
    execute format('revoke all privileges on public.%I from crm_web_sql',item.tablename);
  end loop;
end $$;
-- The application connects as the owner of the CRM tables and switches role with SET LOCAL ROLE, which needs membership.
do $$ declare app_role name; begin
  select tableowner into app_role from pg_tables where schemaname = 'public' and tablename = 'crm_people';
  if app_role is not null and app_role <> current_user then
    execute format('grant crm_agent_sql, crm_web_sql to %I', app_role);
  end if;
end $$;
commit;
