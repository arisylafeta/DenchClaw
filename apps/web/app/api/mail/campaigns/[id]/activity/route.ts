import { guardBulkTrades } from '@/lib/bulk-trades-route';
import { getCampaignActivity } from '@/lib/campaign-activity-server';
export const dynamic = 'force-dynamic';
export async function GET(_req:Request, context:{params:Promise<{id:string}>}) {
 const guard = await guardBulkTrades('Mail'); if ('response' in guard) return guard.response;
 const {id} = await context.params; const data = await getCampaignActivity(id);
 return data ? Response.json(data) : Response.json({error:'Not found'},{status:404});
}
