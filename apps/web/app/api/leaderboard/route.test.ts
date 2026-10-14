import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
vi.mock('@/lib/auth',()=>({currentUser:vi.fn()}));
vi.mock('@/lib/leaderboard/query',()=>({getLeaderboard:vi.fn()}));
import {currentUser, type AuthenticatedUser} from '@/lib/auth';
import {getLeaderboard} from '@/lib/leaderboard/query';
import {GET} from './route';
beforeEach(()=>vi.resetAllMocks());afterEach(()=>vi.unstubAllEnvs());
const user: AuthenticatedUser = {id:'crm-user',email:'test@example.org',displayName:'Test'};
describe('leaderboard authorization and options',()=>{
  it('requires authentication',async()=>{
    vi.mocked(currentUser).mockResolvedValue(null);expect((await GET(new Request('http://localhost/api/leaderboard'))).status).toBe(401);expect(getLeaderboard).not.toHaveBeenCalled();
  });
  it('requires an explicitly configured postgres backend',async()=>{
    vi.mocked(currentUser).mockResolvedValue(user);vi.stubEnv('CRM_DB_BACKEND','');expect((await GET(new Request('http://localhost/api/leaderboard'))).status).toBe(503);
  });
  it('preserves source error and asOf instead of returning zeros as success',async()=>{
    vi.mocked(currentUser).mockResolvedValue(user);vi.stubEnv('CRM_DB_BACKEND','postgres');
    vi.mocked(getLeaderboard).mockResolvedValue({source:'error',error:'PostHog unavailable',asOf:'2026-10-14',rows:[],total:0,counts:{new:0,active:0,rising:0,cooling:0,dormant:0,never_active:0}});
    const response=await GET(new Request('http://localhost/api/leaderboard?window=90&role=buyer&inCrm=true&noOffer=true&limit=25&offset=10'));
    expect(response.status).toBe(503);expect(await response.json()).toMatchObject({source:'error',asOf:'2026-10-14'});expect(getLeaderboard).toHaveBeenCalledWith(expect.objectContaining({window:90,role:'buyer',inCrm:true,noOffer:true,limit:25,offset:10}));
  });
});
