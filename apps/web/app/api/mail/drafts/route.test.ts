import { beforeEach, expect, it, vi } from 'vitest';
const { currentUser, listMailDrafts, readMailDraft } = vi.hoisted(() => ({currentUser:vi.fn(),listMailDrafts:vi.fn(),readMailDraft:vi.fn()}));
vi.mock('@/lib/auth',()=>({currentUser}));
vi.mock('@/lib/crm-postgres/mail',()=>({listMailDrafts,readMailDraft}));
vi.mock('@/lib/mail-draft-actions',()=>({editableCopy:async()=>({main:'copy',signature:null}),editDraft:vi.fn(),DraftActionError:class extends Error{}}));
import { GET as list } from './route';
import { GET as read } from './[id]/route';
beforeEach(()=>{vi.resetAllMocks();});
it('rejects unauthenticated list and read before querying',async()=>{
 currentUser.mockResolvedValue(null);
 expect((await list(new Request('http://localhost/api/mail/drafts'))).status).toBe(401);
 expect((await read(new Request('http://localhost/x'),{params:Promise.resolve({id:'d1'})})).status).toBe(401);
 expect(listMailDrafts).not.toHaveBeenCalled(); expect(readMailDraft).not.toHaveBeenCalled();
});
it('scopes both reads to the signed-in user',async()=>{
 currentUser.mockResolvedValue({id:'u1'}); listMailDrafts.mockResolvedValue([]); readMailDraft.mockResolvedValue({id:'d1'});
 expect(await (await list(new Request('http://localhost/api/mail/drafts?limit=5'))).json()).toEqual({items:[]});
 expect(listMailDrafts).toHaveBeenCalledWith('u1',5,{});
 await list(new Request('http://localhost/api/mail/drafts?q=ioniq&identity=ari&to=a@example.test&mailboxOwnerId=other'));
 expect(listMailDrafts).toHaveBeenLastCalledWith('u1',50,{q:'ioniq',identity:'ari',to:'a@example.test'});
 expect(await (await read(new Request('http://localhost/x'),{params:Promise.resolve({id:'d1'})})).json()).toEqual({id:'d1',editable:{main:'copy',signature:null}});
 expect(readMailDraft).toHaveBeenCalledWith('d1','u1');
});
it('returns 404 for a missing or foreign draft',async()=>{
 currentUser.mockResolvedValue({id:'u1'}); readMailDraft.mockResolvedValue(null);
 expect((await read(new Request('http://localhost/x'),{params:Promise.resolve({id:'nope'})})).status).toBe(404);
});
