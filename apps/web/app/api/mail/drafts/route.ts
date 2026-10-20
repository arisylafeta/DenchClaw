import { currentUser } from '@/lib/auth';
import { listMailDrafts } from '@/lib/crm-postgres/mail';
export const dynamic = 'force-dynamic';
export async function GET(req: Request) {
 const user = await currentUser();
 if (!user) return Response.json({error:'Unauthorized'},{status:401});
 const limit = Number(new URL(req.url).searchParams.get('limit')) || 50;
 return Response.json({ items: await listMailDrafts(user.id, limit) });
}
