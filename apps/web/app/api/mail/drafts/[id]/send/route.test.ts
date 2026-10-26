import { beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({currentUser:vi.fn(),readMailDraft:vi.fn(),sendDraft:vi.fn()}));
vi.mock('@/lib/auth',()=>({currentUser:m.currentUser,ALLOWED_EMAILS:new Set(['ari@rebattery.io'])}));
vi.mock('@/lib/crm-postgres/mail',()=>({readMailDraft:m.readMailDraft}));
vi.mock('@/lib/mail-draft-actions',()=>({sameVersion:(a:string|Date,b:string|Date)=>new Date(a).getTime()===new Date(b).getTime(),sendDraft:m.sendDraft,DraftActionError:class extends Error{status=409}}));
import { POST } from './route';
const call = (body: unknown) => POST(new Request('http://x',{method:'POST',body:JSON.stringify(body)}),{params:Promise.resolve({id:'d1'})});
beforeEach(()=>{vi.resetAllMocks(); m.currentUser.mockResolvedValue({id:'u1',email:'ari@rebattery.io',displayName:'Ari Sylafeta'}); m.readMailDraft.mockResolvedValue({id:'d1',updated_at:'2026-10-20T10:00:00Z'});});
it('rejects anonymous users and non-admins before reading the draft',async()=>{
 m.currentUser.mockResolvedValue(null); expect((await call({confirm:true,updated_at:'x'})).status).toBe(401);
 m.currentUser.mockResolvedValue({id:'u2',email:'other@rebattery.io',displayName:'Other'}); expect((await call({confirm:true,updated_at:'x'})).status).toBe(403);
 expect(m.readMailDraft).not.toHaveBeenCalled(); expect(m.sendDraft).not.toHaveBeenCalled();
});
it('needs an explicit confirmation',async()=>{
 expect((await call({updated_at:'2026-10-20T10:00:00Z'})).status).toBe(400);
 expect((await call({confirm:'yes',updated_at:'2026-10-20T10:00:00Z'})).status).toBe(400);
 expect(m.sendDraft).not.toHaveBeenCalled();
});
it('refuses when the draft changed after the person looked',async()=>{
 expect((await call({confirm:true,updated_at:'2026-10-20T09:00:00Z'})).status).toBe(409);
 expect(m.sendDraft).not.toHaveBeenCalled();
});
it('matches versions when the database returns a Date with milliseconds',async()=>{
 m.readMailDraft.mockResolvedValue({id:'d1',updated_at:new Date('2026-10-26T12:08:17.871Z')}); m.sendDraft.mockResolvedValue({sent:true});
 expect((await call({confirm:true,updated_at:'2026-10-26T12:08:17.871Z'})).status).toBe(200);
});
it('sends the confirmed version, naming the signed-in person as approver',async()=>{
 m.sendDraft.mockResolvedValue({sent:true});
 const res = await call({confirm:true,updated_at:'2026-10-20T10:00:00Z'});
 expect(res.status).toBe(200);
 expect(m.sendDraft).toHaveBeenCalledWith({id:'d1',updated_at:'2026-10-20T10:00:00Z'},'Ari Sylafeta');
});
