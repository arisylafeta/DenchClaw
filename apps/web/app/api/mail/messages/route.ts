import { currentUser } from '@/lib/auth';
import { searchMail } from '@/lib/crm-postgres/mail';
import type { MailFilters } from '@/lib/mail-types';
export const dynamic = 'force-dynamic';
export async function GET(req: Request) {
 const user = await currentUser();
 if (!user) return Response.json({error:'Unauthorized'}, {status:401});
 const params = new URL(req.url).searchParams;
 const filters: MailFilters = { mailboxOwnerId: user.id };
 for (const key of ['view','q','from','to','identity','campaign','thread','person','direction','transport','purpose','state','event','since','until','cursor'] as const) {
  const value = params.get(key); if (value) Object.assign(filters,{[key]:value});
 }
 filters.crmOnly = params.get('crmOnly') === 'true';
 filters.showInternal = params.get('showInternal') === 'true';
 filters.limit = Number(params.get('limit')) || 50;
 try { return Response.json(await searchMail(filters)); }
 catch (error) { if (error instanceof Error && error.message === 'invalid_cursor') return Response.json({error:'invalid_cursor'},{status:400}); throw error; }
}
