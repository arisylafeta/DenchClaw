import {describe, expect, it} from 'vitest';
import {assignSegment, scoreActivity, type Activity} from './scoring';
const now = Date.parse('2026-10-14T12:00:00Z');
const base: Activity = {authUserId:'id', role:'buyer',accountStatus:'active',totalEvents:10,lastSeen:new Date(now).toISOString(),sessions:2,activeDays:2,engagementScore:20,recentEvents:2,previousEvents:2,actions:[{event:'listing_offer_submitted',count:1},{event:'marketplace_listing_clicked',count:3}],hasOffer:true};
describe('activity scoring', () => {
  it('weights intent and halves it after fourteen days', () => {
    expect(scoreActivity(base,now)).toEqual({intentScore:46,engagementScore:20,score:46});
    expect(scoreActivity({...base,lastSeen:new Date(now-14*86400000).toISOString()},now).score).toBe(23);
  });
  it('separates never-active, dormant, cooling, new, rising and active', () => {
    expect(assignSegment(undefined,null,now)).toBe('never_active');
    expect(assignSegment({...base,lastSeen:new Date(now-30*86400000).toISOString()},null,now)).toBe('dormant');
    expect(assignSegment({...base,lastSeen:new Date(now-7*86400000).toISOString()},null,now)).toBe('cooling');
    expect(assignSegment(base,new Date(now-86400000).toISOString(),now)).toBe('new');
    expect(assignSegment({...base,recentEvents:5},null,now)).toBe('rising');
    expect(assignSegment(base,null,now)).toBe('active');
  });
});
