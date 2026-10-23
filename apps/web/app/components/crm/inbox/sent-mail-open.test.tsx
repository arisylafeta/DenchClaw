// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { InboxView } from './inbox-view';
const nav=vi.hoisted(()=>({replace:vi.fn(),params:new URLSearchParams()}));
vi.mock('next/navigation',()=>({useRouter:()=>({replace:nav.replace}),useSearchParams:()=>nav.params}));
vi.mock('./inbox-layout',()=>({PANEL_LAYOUT:{},InboxLayout:({list,conversation}:{list:React.ReactNode;conversation:React.ReactNode})=><div>{list}{conversation}</div>}));
const row={id:'sent-example',thread_id:'team-thread',direction:'outbound',state:'accepted',identity_key:'supply',from_email:'supply@rebattery.io',to_emails:['seller@example.test'],cc_emails:[],subject:'Your stock is live',body_preview:'Short snippet',sent_at:'2026-01-01T00:00:00Z',created_at:'2026-01-01T00:00:00Z',is_self:true,events:[],has_attachments:false};
beforeEach(()=>{Element.prototype.scrollIntoView=vi.fn();vi.stubGlobal('fetch',vi.fn(async(url)=>{const u=String(url);if(u==='/api/mail/messages/sent-example')return new Response(JSON.stringify({...row,body_text:'Full content',body_html:'<p style="color:green">Complete standalone email</p>'}));if(u.startsWith('/api/mail/threads/team-thread'))return new Response(JSON.stringify({thread_id:'team-thread',messages:[{...row,body:'Full content',body_html:'<p style="color:green">Complete branded email</p>',preview:'Short snippet'}],people:[]}));return new Response(JSON.stringify({items:u.includes('/identities')?[]:[row],nextCursor:null}));}));});
afterEach(()=>vi.unstubAllGlobals());
it('opens a sent row in the full HTML reader and returns to the list',async()=>{
 render(<InboxView initialView="sent"/>);
 fireEvent.click(await screen.findByRole('button',{name:'Open email: Your stock is live'}));
 const frame=await screen.findByTitle('Email body');expect(frame.getAttribute('srcdoc')).toContain('Complete branded email');
 expect(fetch).toHaveBeenCalledWith('/api/mail/messages/sent-example');
 expect(vi.mocked(fetch).mock.calls.some(([u])=>String(u).startsWith('/api/mail/threads/team-thread'))).toBe(true);
 fireEvent.click(screen.getByRole('button',{name:'Back to sent'}));expect(screen.queryByTitle('Email body')).not.toBeInTheDocument();
 expect(screen.getByRole('button',{name:'Open email: Your stock is live'})).toBeInTheDocument();
});
it('opens unthreaded email HTML instead of showing a missing-thread message',async()=>{
 vi.mocked(fetch).mockImplementation(async(url)=>new Response(JSON.stringify(String(url)==='/api/mail/messages/sent-example'?{...row,thread_id:null,body_text:'Full standalone body',body_html:'<p>Complete standalone email</p>'}:{items:String(url).includes('/identities')?[]:[{...row,thread_id:null}],nextCursor:null})));
 render(<InboxView initialView="sent"/>);fireEvent.click(await screen.findByRole('button',{name:'Open email: Your stock is live'}));
 expect((await screen.findByTitle('Email body')).getAttribute('srcdoc')).toContain('Complete standalone email');expect(screen.queryByText('This email is not part of a thread.')).not.toBeInTheDocument();
});
it('does not open the reader when expanding delivery activity',async()=>{
 render(<InboxView initialView="sent"/>);fireEvent.click(await screen.findByLabelText('Delivery activity: Your stock is live'));
 expect(screen.queryByRole('button',{name:'Back to sent'})).not.toBeInTheDocument();
 expect(vi.mocked(fetch).mock.calls.some(([u])=>String(u)==='/api/mail/messages/sent-example')).toBe(false);
});
it('closes a selected email when filters change',async()=>{
 render(<InboxView initialView="sent"/>);fireEvent.click(await screen.findByRole('button',{name:'Open email: Your stock is live'}));await screen.findByTitle('Email body');
 fireEvent.change(screen.getByRole('searchbox',{name:'Search mail'}),{target:{value:'other'}});
 await waitFor(()=>expect(screen.queryByRole('button',{name:'Back to sent'})).not.toBeInTheDocument());
});
