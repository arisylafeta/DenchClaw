import { currentUser } from '@/lib/auth';
import { readMailThread } from '@/lib/crm-postgres/mail';
export const dynamic = 'force-dynamic';
export async function GET(req: Request, context: {params: Promise<{id:string}>}) {
 const user = await currentUser();
 if (!user) return Response.json({error:'Unauthorized'},{status:401});
 const {id} = await context.params;
 const data = await readMailThread(id,user.id,new URL(req.url).searchParams.get('crmOnly') === 'true');
 return data ? Response.json(data) : Response.json({error:'Not found'},{status:404});
}
