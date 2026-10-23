#!/usr/bin/env python3
"""Exercise the migration in an isolated, synthetic Postgres cluster. Never connects to CRM."""
import os, pathlib, pwd, shutil, subprocess, tempfile
root = pathlib.Path(__file__).resolve().parents[1]
base = pathlib.Path(tempfile.mkdtemp(prefix="reb559-pg-", dir=os.environ["TMPDIR"]))
user = pwd.getpwnam("postgres")
os.chown(base,user.pw_uid,user.pw_gid)
bindir = pathlib.Path("/usr/lib/postgresql/16/bin")
def demote():
 os.setgid(user.pw_gid); os.setuid(user.pw_uid)
env = {"PATH":"/usr/bin:/bin", "HOME":str(base), "LANG":"C.UTF-8"}
def run(name,*args,input=None,as_postgres=True):
 p=subprocess.run([str(bindir/name),*args],cwd=base,env=env,pass_fds=(fd,),preexec_fn=demote if as_postgres else None,input=input,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
 if p.returncode: raise RuntimeError(p.stdout)
 return p.stdout
fd=os.open(base,os.O_RDONLY | os.O_DIRECTORY)
os.set_inheritable(fd,True)
data=f"/proc/self/fd/{fd}/data"
started=False
try:
 print(run("initdb","-D",data,"-A","trust","--no-locale"))
 print(run("pg_ctl","-D",data,"-l","server.log","-o","-c listen_addresses='' -c unix_socket_directories='.' -p 55459","-w","start"));started=True
 socket=str(base/"data")
 print(run("psql","-X","-v","ON_ERROR_STOP=1","-h",socket,"-p","55459","-U","postgres","-d","postgres",input="create database reb559_access_test;",as_postgres=False))
 setup="create table crm_users(id uuid primary key); create role crm_agent_sql; create role crm_web_sql; insert into crm_users values('00000000-0000-0000-0000-000000000001');"
 sql=setup+"\n"+(root/"lib/crm-postgres/migrations/085_hermes_conversation_access.sql").read_text()+"\n"+"""
insert into hermes_security.conversation_access(kind,profile,stored_id,creator_id,owner_id,origin,visibility) values('solo','agent','private','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001','crm','private');
do $$ begin
 if has_schema_privilege('crm_web_sql','hermes_security','usage') or has_schema_privilege('crm_agent_sql','hermes_security','usage') or has_table_privilege('crm_agent_sql','hermes_security.conversation_access','select') or has_table_privilege('crm_web_sql','hermes_security.conversation_access','select') then raise exception 'raw SQL exposure'; end if;
 begin update hermes_security.conversation_access set origin='discord'; raise exception 'origin changed'; exception when raise_exception then if sqlerrm='origin changed' then raise; end if; end;
 begin update hermes_security.conversation_access set owner_id=null,creator_id=null; raise exception 'owner changed'; exception when raise_exception then if sqlerrm='owner changed' then raise; end if; end;
end $$;
update hermes_security.conversation_access set visibility='team';
do $$ begin if (select version from hermes_security.conversation_access)<>2 then raise exception 'version not advanced'; end if; end $$;
update hermes_security.conversation_access set deleted_at=now();
do $$ begin
 begin update hermes_security.conversation_access set deleted_at=null; raise exception 'resurrected'; exception when raise_exception then if sqlerrm='resurrected' then raise; end if; end;
 begin delete from hermes_security.conversation_access; raise exception 'deleted tombstone'; exception when raise_exception then if sqlerrm='deleted tombstone' then raise; end if; end;
end $$;
select 'migration invariants passed' as result;
"""
 print(run("psql","-X","-v","ON_ERROR_STOP=1","-h",socket,"-p","55459","-U","postgres","-d","reb559_access_test",input=sql,as_postgres=False))
 from urllib.parse import quote
 test_env={**env,"CONVERSATION_ACCESS_TEST_DATABASE_URL":f"postgresql://postgres@localhost:55459/reb559_access_test?host={quote(socket,safe='')}"}
 pnpm=shutil.which("pnpm")
 if not pnpm: raise RuntimeError("pnpm required for store integration")
 result=subprocess.run([pnpm,"exec","tsx","scripts/test-conversation-access-store.ts"],cwd=root,env=test_env,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
 print(result.stdout)
 if result.returncode: raise RuntimeError("Store integration failed")
finally:
 if started: print(run("pg_ctl","-D",data,"-m","immediate","-w","stop"))
 shutil.rmtree(base)
