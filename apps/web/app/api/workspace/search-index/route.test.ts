import {expect,it,vi} from 'vitest';
const {queryPg}=vi.hoisted(()=>({queryPg:vi.fn()}));
vi.mock('@/lib/auth',()=>({currentUser:async()=>({id:'owner'})}));
vi.mock('@/lib/postgres',()=>({queryPg}));
vi.mock('@/lib/workspace',()=>({resolveWorkspaceRoot:()=>null,parseSimpleYaml:vi.fn(),isDatabaseFile:vi.fn(),readObjectYamlIcon:vi.fn()}));
vi.mock('@/lib/crm-postgres/table-columns',()=>({getTableColumns:async()=>new Set(['subject'])}));
import {GET} from './route';
it('indexes only CRM-visible mail from the authenticated mailbox',async()=>{
 queryPg.mockImplementation(async(sql:string)=>{
  if(sql.includes('from crm_objects'))return [{id:'mail-object',name:'email_message',display_field:'Subject'}];
  if(sql.includes('from crm_fields'))return [{id:'subject',name:'Subject',type:'text',canonical_column:'subject'}];
  return [];
 });
 await GET();
 const [sql,params]=queryPg.mock.calls.find(([sql])=>sql.includes('from mail_message'))!;
 expect(sql).toContain('crm_visible = true'); expect(sql).toContain('mailbox_owner_id = $1::uuid'); expect(params).toEqual(['owner']);
});
