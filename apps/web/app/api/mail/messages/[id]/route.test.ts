import { beforeEach, expect, it, vi } from 'vitest';
const { currentUser, readMailMessage } = vi.hoisted(() => ({currentUser:vi.fn(),readMailMessage:vi.fn()}));
vi.mock('@/lib/auth',()=>({currentUser}));
vi.mock('@/lib/crm-postgres/mail',()=>({readMailMessage}));
import { GET } from './route';
const ctx = (id:string)=>({params:Promise.resolve({id})});
beforeEach(()=>{vi.resetAllMocks();});
it('rejects an unauthenticated read before querying',async()=>{
 currentUser.mockResolvedValue(null);
 expect((await GET(new Request('http://localhost/x'),ctx('m1'))).status).toBe(401);
 expect(readMailMessage).not.toHaveBeenCalled();
});
it('scopes the read to the signed-in user',async()=>{
 currentUser.mockResolvedValue({id:'u1'}); readMailMessage.mockResolvedValue({id:'m1'});
 expect(await (await GET(new Request('http://localhost/x'),ctx('m1'))).json()).toEqual({id:'m1'});
 expect(readMailMessage).toHaveBeenCalledWith('m1','u1');
});
it('returns 404 for a missing or foreign message',async()=>{
 currentUser.mockResolvedValue({id:'u1'}); readMailMessage.mockResolvedValue(null);
 expect((await GET(new Request('http://localhost/x'),ctx('nope'))).status).toBe(404);
});
