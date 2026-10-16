import { guardBulkTrades } from '@/lib/bulk-trades-route';
import { readMailCampaign } from '@/lib/crm-postgres/mail';
import { mailFilters } from '../../filters';
export const dynamic = 'force-dynamic';
export async function GET(req: Request, context: {params: Promise<{id:string}>}) {
 const guard = await guardBulkTrades('Mail'); if ('response' in guard) return guard.response;
 const {id} = await context.params; const data = await readMailCampaign(id,mailFilters(req));
 return data ? Response.json(data) : Response.json({error:'Not found'},{status:404});
}
