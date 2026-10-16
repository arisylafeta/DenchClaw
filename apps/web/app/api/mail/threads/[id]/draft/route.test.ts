import { beforeEach, expect, it, vi } from 'vitest';
const { currentUser, queryPg, readMailThread }=vi.hoisted(()=>({currentUser:vi.fn(),queryPg:vi.fn(),readMailThread:vi.fn()}));
vi.mock('@/lib/auth',()=>({currentUser}));
vi.mock('@/lib/postgres',()=>({queryPg}));
vi.mock('@/lib/crm-postgres/mail',()=>({readMailThread}));
import { POST } from './route';
const context={params:Promise.resolve({id:'thread'})};
beforeEach(()=>{vi.resetAllMocks();currentUser.mockResolvedValue({id:'owner',email:'ari@example.test'});});
it('creates an unsent draft using the authorised thread and an active identity',async()=>{
 readMailThread.mockResolvedValue({subject:'Packs',messages:[{direction:'inbound',from_email:'buyer@example.test',from_person_id:null}]});
 queryPg.mockResolvedValueOnce([{key:'ari',address:'ari@rebattery.io'}]).mockResolvedValueOnce([]);
 const response=await POST(new Request('http://localhost/api/mail/threads/thread/draft',{method:'POST',body:JSON.stringify({body_text:'Reply draft',identity:'ari'})}),context);
 expect(response.status).toBe(201);expect(await response.json()).toMatchObject({state:'draft'});
 expect(readMailThread).toHaveBeenCalledWith('thread','owner');
 expect(queryPg.mock.calls[1][0]).toContain("'draft'");
 expect(queryPg.mock.calls[1][1]).toContain('buyer@example.test');
 expect(queryPg.mock.calls[1][0]).not.toContain('accepted_at');
});
it('refuses another mailbox thread without creating a draft',async()=>{
 readMailThread.mockResolvedValue(null);
 const response=await POST(new Request('http://localhost/api/mail/threads/thread/draft',{method:'POST',body:'{}'}),context);
 expect(response.status).toBe(404);expect(queryPg).not.toHaveBeenCalled();
});
