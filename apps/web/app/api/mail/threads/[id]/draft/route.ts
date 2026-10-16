import { randomUUID } from 'node:crypto';
import { currentUser } from '@/lib/auth';
import { queryPg } from '@/lib/postgres';
import { readMailThread } from '@/lib/crm-postgres/mail';
export const dynamic = 'force-dynamic';
export async function POST(req: Request, context: {params: Promise<{id:string}>}) {
 const user = await currentUser();
 if (!user) return Response.json({error:'Unauthorized'},{status:401});
 const {id:threadId} = await context.params;
 const thread = await readMailThread(threadId,user.id);
 if (!thread) return Response.json({error:'Not found'},{status:404});
 let data: {body_text?:unknown;identity?:unknown};
 try { data = await req.json(); } catch { return Response.json({error:'invalid_json'},{status:400}); }
 if (typeof data.body_text !== 'string' || !data.body_text.trim()) return Response.json({error:'body_required'},{status:400});
 const [identity] = await queryPg<{key:string;address:string}>(`select key,address from mail_identity where active and gmail_account is not null and 'personal' = any(allowed_purposes) and ${typeof data.identity === 'string' ? 'key = $1' : 'lower(address) = lower($1)'} limit 1`,[typeof data.identity === 'string' ? data.identity : user.email]);
 if (!identity) return Response.json({error:'identity_unavailable'},{status:400});
 const latest = thread.messages.toReversed().find(m => m.direction === 'inbound');
 if (!latest?.from_email) return Response.json({error:'recipient_unavailable'},{status:400});
 const id = `draft_${randomUUID()}`;
 await queryPg(`insert into mail_message (id,direction,transport,purpose,identity_key,mailbox_owner_id,thread_id,subject,body_text,from_email,to_emails,person_id,state,crm_visible,crm_visible_reason)
 values ($1,'outbound','gmail','personal',$2,$3::uuid,$4,$5,$6,$7,array[$8],$9,'draft',true,'thread_reply')`,[id,identity.key,user.id,threadId,thread.subject,data.body_text,identity.address,latest.from_email,latest.from_person_id]);
 return Response.json({id,state:'draft'},{status:201});
}
