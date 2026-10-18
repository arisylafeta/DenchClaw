import { beforeEach, expect, it, vi } from 'vitest';
const { currentUser, searchMail } = vi.hoisted(() => ({currentUser:vi.fn(),searchMail:vi.fn()}));
vi.mock('@/lib/auth',()=>({currentUser}));
vi.mock('@/lib/crm-postgres/mail',()=>({searchMail}));
import { GET } from './route';
beforeEach(()=>{vi.resetAllMocks();});
it('rejects unauthenticated reads before querying the mail log',async()=>{
 currentUser.mockResolvedValue(null);
 expect((await GET(new Request('http://localhost/api/mail/messages'))).status).toBe(401);
 expect(searchMail).not.toHaveBeenCalled();
});
it('binds the authenticated mailbox owner and forwards search filters',async()=>{
 currentUser.mockResolvedValue({id:'owner'}); searchMail.mockResolvedValue({items:[],nextCursor:null});
 const response=await GET(new Request('http://localhost/api/mail/messages?mailboxOwnerId=other&view=conversations&identity=ari&purpose=personal&crmOnly=true&cursor=cursor&limit=10'));
 expect(response.status).toBe(200);
 expect(searchMail).toHaveBeenCalledWith({mailboxOwnerId:'owner',view:'conversations',identity:'ari',purpose:'personal',crmOnly:true,cursor:'cursor',limit:10});
});
it('reports a malformed cursor without returning a server error',async()=>{
 currentUser.mockResolvedValue({id:'owner'}); searchMail.mockRejectedValue(new Error('invalid_cursor'));
 const response=await GET(new Request('http://localhost/api/mail/messages?cursor=bad'));
 expect(response.status).toBe(400); expect(await response.json()).toEqual({error:'invalid_cursor'});
});
it('preserves server self classification rather than inferring it from direction',async()=>{
 currentUser.mockResolvedValue({id:'owner'});
 const items=[{id:'admin',from_email:'admin@rebattery.io',direction:'inbound',is_self:true},{id:'external',from_email:'x@rebattery.io.evil.com',direction:'inbound',is_self:false}];
 searchMail.mockResolvedValue({items,nextCursor:null});
 expect(await (await GET(new Request('http://localhost/api/mail/messages'))).json()).toEqual({items,nextCursor:null});
});
