import { currentUser } from '@/lib/auth';
import { readMailMessage } from '@/lib/crm-postgres/mail';
export const dynamic = 'force-dynamic';
export async function GET(_req: Request, context: {params: Promise<{id:string}>}) {
 const user = await currentUser();
 if (!user) return Response.json({error:'Unauthorized'},{status:401});
 const {id} = await context.params;
 const message = await readMailMessage(id,user.id);
 return message ? Response.json(message) : Response.json({error:'Not found'},{status:404});
}
