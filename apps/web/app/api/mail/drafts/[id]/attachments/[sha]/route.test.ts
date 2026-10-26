import { beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({currentUser:vi.fn(),draftAttachmentFile:vi.fn(),readDraftFile:vi.fn()}));
vi.mock('@/lib/auth',()=>({currentUser:m.currentUser}));
vi.mock('@/lib/crm-postgres/mail',()=>({draftAttachmentFile:m.draftAttachmentFile}));
vi.mock('@/lib/mail-draft-files',async(orig)=>({...(await orig() as object),readDraftFile:m.readDraftFile}));
import { GET } from './route';
const SHA = 'a'.repeat(64);
const call = (sha: string, q = '') => GET(new Request('http://x/'+q),{params:Promise.resolve({id:'d1',sha})});
beforeEach(()=>{vi.resetAllMocks(); m.currentUser.mockResolvedValue({id:'u1'});});
it('needs a signed-in user and a well-formed checksum before looking anything up',async()=>{
 m.currentUser.mockResolvedValue(null); expect((await call(SHA)).status).toBe(401);
 m.currentUser.mockResolvedValue({id:'u1'}); expect((await call('../../etc/passwd')).status).toBe(404);
 expect(m.draftAttachmentFile).not.toHaveBeenCalled();
});
it('404s for a draft the user cannot see or a file that fails the checks',async()=>{
 m.draftAttachmentFile.mockResolvedValue(null); expect((await call(SHA)).status).toBe(404);
 m.draftAttachmentFile.mockResolvedValue({path:'/p',filename:'a.jpg',mediaType:'image/jpeg'}); m.readDraftFile.mockResolvedValue(null);
 expect((await call(SHA)).status).toBe(404);
});
it('serves a download by default and an image inline on request',async()=>{
 m.draftAttachmentFile.mockResolvedValue({path:'/p',filename:'a.jpg',mediaType:'image/jpeg'});
 m.readDraftFile.mockResolvedValue({bytes:Buffer.from('x'),filename:'a.jpg',mediaType:'image/jpeg'});
 expect((await call(SHA)).headers.get('content-disposition')).toMatch(/^attachment/);
 expect((await call(SHA,'?inline=1')).headers.get('content-disposition')).toMatch(/^inline/);
 expect(m.draftAttachmentFile).toHaveBeenCalledWith('d1','u1',SHA);
});
