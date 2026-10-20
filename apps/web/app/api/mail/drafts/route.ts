import { currentUser } from '@/lib/auth';
import { listMailDrafts, type MailDraftFilters } from '@/lib/crm-postgres/mail';
export const dynamic = 'force-dynamic';
export async function GET(req: Request) {
 const user = await currentUser();
 if (!user) return Response.json({error:'Unauthorized'},{status:401});
 const params = new URL(req.url).searchParams;
 const filters: MailDraftFilters = {};
 for (const key of ['q','identity','to','from','purpose','transport','state','since','until'] as const) { const value = params.get(key); if (value) filters[key] = value; }
 return Response.json({ items: await listMailDrafts(user.id, Number(params.get('limit')) || 50, filters) });
}
