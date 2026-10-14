// @vitest-environment jsdom
import {afterEach, describe, expect, it, vi} from 'vitest';
import {fireEvent, render, screen, waitFor, cleanup} from '@testing-library/react';
import {LeaderboardView} from './leaderboard-view';
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
const payload={source:'ok',asOf:'2026-10-14T00:00:00Z',total:1,counts:{active:1,rising:0,cooling:0,dormant:0,never_active:0,new:0},rows:[{authUserId:'account',personId:'person',name:'Ada',email:null,company:'Battery Works',role:'buyer',score:40,intentScore:40,engagementScore:2,activeDays:2,lastSeen:null,segment:'active',topActions:[],inCrm:true,reviewStatus:'auto',emailOptedOut:false}]};
describe('leaderboard view',()=>{
  it('defaults to buyers and opens the existing person profile',async()=>{
    const fetch=vi.fn().mockResolvedValue(Response.json(payload));vi.stubGlobal('fetch',fetch);const open=vi.fn();render(<LeaderboardView onOpenPerson={open}/>);
    fireEvent.click(await screen.findByRole('button',{name:'Ada'}));expect(open).toHaveBeenCalledWith('person');expect(fetch.mock.calls[0][0]).toContain('role=buyer');
    fireEvent.change(screen.getByLabelText('Role'),{target:{value:'supplier'}});await waitFor(()=>expect(fetch.mock.calls.at(-1)?.[0]).toContain('role=supplier'));
  });
  it('surfaces provider errors with no zero-count fiction',async()=>{
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json({source:'error',error:'PostHog unavailable'},{status:503})));render(<LeaderboardView/>);
    expect(await screen.findByRole('alert')).toHaveTextContent('PostHog unavailable');expect(screen.queryByRole('table')).toBeNull();
  });
  it('opens review for unmatched identities',async()=>{
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json({...payload,rows:[{...payload.rows[0],personId:null,inCrm:false,reviewStatus:'needs_review'}]})));render(<LeaderboardView/>);
    fireEvent.click(await screen.findByRole('button',{name:'Ada'}));expect(screen.getByRole('dialog')).toHaveTextContent('No CRM person is linked');
  });
});
