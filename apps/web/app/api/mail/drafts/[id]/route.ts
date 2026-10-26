import { currentUser } from '@/lib/auth';
import { readMailDraft } from '@/lib/crm-postgres/mail';
import { DraftActionError, editDraft, editableCopy, sameVersion } from '@/lib/mail-draft-actions';
export const dynamic = 'force-dynamic';
type Context = {params: Promise<{id:string}>};

async function withCopy(draft: NonNullable<Awaited<ReturnType<typeof readMailDraft>>>) {
 return {...draft, editable: await editableCopy(draft)};
}
export async function GET(_req: Request, context: Context) {
 const user = await currentUser();
 if (!user) return Response.json({error:'Unauthorized'},{status:401});
 const {id} = await context.params;
 const draft = await readMailDraft(id,user.id);
 return draft ? Response.json(await withCopy(draft)) : Response.json({error:'Not found'},{status:404});
}
/** Edits the subject and/or main copy of an unsent draft. `updated_at` is the version the editor saw: a newer one wins. */
export async function PATCH(req: Request, context: Context) {
 const user = await currentUser();
 if (!user) return Response.json({error:'Unauthorized'},{status:401});
 const {id} = await context.params;
 const body = await req.json().catch(() => null) as {subject?: unknown; body?: unknown; updated_at?: unknown} | null;
 if (!body || (body.subject !== undefined && typeof body.subject !== 'string') || (body.body !== undefined && typeof body.body !== 'string') || typeof body.updated_at !== 'string') {
  return Response.json({error:'subject, body and updated_at are required in the right shape'},{status:400});
 }
 if (typeof body.subject === 'string' && (!body.subject.trim() || body.subject.length > 300)) return Response.json({error:'The subject must be 1 to 300 characters.'},{status:400});
 const current = await readMailDraft(id,user.id);
 if (!current) return Response.json({error:'Not found'},{status:404});
 if (!sameVersion(current.updated_at,body.updated_at)) return Response.json({error:'This draft changed since you opened it. Reload to see the latest.'},{status:409});
 try {
  await editDraft(current,{subject: body.subject as string | undefined, body: body.body as string | undefined});
  const updated = await readMailDraft(id,user.id);
  return updated ? Response.json(await withCopy(updated)) : Response.json({error:'Not found'},{status:404});
 } catch (error) {
  if (error instanceof DraftActionError) return Response.json({error: error.message},{status: error.status});
  throw error;
 }
}
