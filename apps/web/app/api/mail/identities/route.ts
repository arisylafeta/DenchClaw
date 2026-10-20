import { currentUser } from '@/lib/auth';
import { mailIdentityCounts } from '@/lib/crm-postgres/mail';
import type { MailFilters } from '@/lib/mail-types';
export const dynamic = 'force-dynamic';
// Message counts per identity for the account rail. Same scope as /api/mail/messages, ignoring the identity filter itself.
export async function GET(req: Request) {
 const user = await currentUser();
 if (!user) return Response.json({error:'Unauthorized'}, {status:401});
 const params = new URL(req.url).searchParams;
 const filters: MailFilters = { mailboxOwnerId: user.id };
 for (const key of ['view','q','from','to','campaign','thread','person','direction','transport','purpose','state','event','since','until'] as const) {
  const value = params.get(key); if (value) Object.assign(filters,{[key]:value});
 }
 filters.crmOnly = params.get('crmOnly') === 'true';
 filters.showInternal = params.get('showInternal') === 'true';
 return Response.json({ items: await mailIdentityCounts(filters) });
}
