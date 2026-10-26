import { ALLOWED_EMAILS, currentUser } from '@/lib/auth';
import { readMailDraft } from '@/lib/crm-postgres/mail';
import { DraftActionError, sameVersion, sendDraft } from '@/lib/mail-draft-actions';
export const dynamic = 'force-dynamic';

/** Sends one unsent draft. Admins only (the CLI treats the named approver as the go-ahead), and only the exact version the person confirmed. */
export async function POST(req: Request, context: {params: Promise<{id:string}>}) {
 const user = await currentUser();
 if (!user) return Response.json({error:'Unauthorized'},{status:401});
 if (!ALLOWED_EMAILS.has(user.email.toLowerCase())) return Response.json({error:'Only Ari or Alex can send from here.'},{status:403});
 const {id} = await context.params;
 const body = await req.json().catch(() => null) as {confirm?: unknown; updated_at?: unknown} | null;
 if (!body || body.confirm !== true || typeof body.updated_at !== 'string') return Response.json({error:'Confirmation and updated_at are required.'},{status:400});
 const draft = await readMailDraft(id,user.id);
 if (!draft) return Response.json({error:'Not found'},{status:404});
 if (!sameVersion(draft.updated_at,body.updated_at)) return Response.json({error:'This draft changed since you looked at it. Review it again before sending.'},{status:409});
 try {
  return Response.json(await sendDraft(draft,user.displayName));
 } catch (error) {
  if (error instanceof DraftActionError) return Response.json({error: error.message},{status: error.status});
  throw error;
 }
}
