import { mailFilters } from '../filters';
import { currentUser } from '@/lib/auth';
import { listMailFollowups } from '@/lib/crm-postgres/mail';
export const dynamic = 'force-dynamic';
export async function GET(req: Request) {
 const user = await currentUser(); if (!user) return Response.json({error:'Unauthorized'},{status:401});
 return Response.json({items:await listMailFollowups(user.id,new URL(req.url).searchParams.get('due') === 'true',mailFilters(req))});
}
