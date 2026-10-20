import { currentUser } from '@/lib/auth';
import { readMailDraft } from '@/lib/crm-postgres/mail';
export const dynamic = 'force-dynamic';
export async function GET(_req: Request, context: {params: Promise<{id:string}>}) {
 const user = await currentUser();
 if (!user) return Response.json({error:'Unauthorized'},{status:401});
 const {id} = await context.params;
 const draft = await readMailDraft(id,user.id);
 return draft ? Response.json(draft) : Response.json({error:'Not found'},{status:404});
}
