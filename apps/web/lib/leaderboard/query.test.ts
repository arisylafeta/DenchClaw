import {beforeEach, describe, expect, it, vi} from 'vitest';
vi.mock('../postgres', () => ({queryPg:vi.fn()}));
vi.mock('./posthog', () => ({getPostHogActivity:vi.fn()}));
import {queryPg} from '../postgres';
import {getPostHogActivity} from './posthog';
import {filterLeaderboard, getLeaderboard, type LeaderboardRow} from './query';
const row: LeaderboardRow = {authUserId:'a',personId:'person',name:'Ada',email:'ada@example.org',company:'Battery Works',role:'buyer',accountStatus:'approved',score:40,intentScore:40,engagementScore:5,sessions:1,activeDays:1,lastSeen:'2026-10-14T00:00:00Z',segment:'active',topActions:[],inCrm:true,reviewStatus:'auto',emailOptedOut:false,hasOffer:false};
beforeEach(() => vi.resetAllMocks());
describe('leaderboard query', () => {
  it('intersects search, roles, segment, CRM and no-offer before pagination', () => {
    const rows=[row,{...row,authUserId:'b',name:'Ben',role:'supplier',inCrm:false},{...row,authUserId:'c',name:'Cora',hasOffer:true},{...row,authUserId:'d',name:'Dev',segment:'dormant' as const}];
    const result=filterLeaderboard(rows,{window:30,q:'battery',role:'buyer',inCrm:true,noOffer:true,segment:'active',limit:1,offset:0});
    expect(result.rows.map(r=>r.name)).toEqual(['Ada']); expect(result.total).toBe(1); expect(result.counts.dormant).toBe(1);
    expect(filterLeaderboard(rows,{window:30,q:'ADA@',limit:10,offset:0}).total).toBe(4);
    expect(filterLeaderboard(rows,{window:30,q:'ben',limit:10,offset:0}).rows[0].authUserId).toBe('b');
  });
  it('shows provider failure instead of synthesized activity', async () => {
    vi.mocked(getPostHogActivity).mockRejectedValueOnce(new Error('PostHog response incomplete'));
    vi.mocked(queryPg).mockResolvedValueOnce([]);
    const result=await getLeaderboard({window:7,limit:10,offset:0});
    expect(result.source).toBe('error'); expect(result.error).toBe('PostHog response incomplete'); expect(result.rows).toEqual([]);
  });
  it('keeps unlinked and never-active platform identities', async () => {
    vi.mocked(getPostHogActivity).mockResolvedValueOnce([]);
    vi.mocked(queryPg).mockResolvedValueOnce([{auth_user_id:'z',person_id:null,name:null,email:null,company:null,account_role:'buyer',account_status:'approved',auth_created_at:null,review_status:'needs_review',email_opted_out:null}]);
    const result=await getLeaderboard({window:90,limit:10,offset:0});
    expect(result.source).toBe('ok'); expect(result.rows[0]).toMatchObject({authUserId:'z',segment:'never_active',inCrm:false});
  });
});
