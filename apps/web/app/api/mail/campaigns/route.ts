import { mailFilters } from '../filters';
import { guardBulkTrades } from '@/lib/bulk-trades-route';
import { listMailCampaigns } from '@/lib/crm-postgres/mail';
export const dynamic = 'force-dynamic';
export async function GET(req: Request) {
 const guard = await guardBulkTrades('Mail'); if ('response' in guard) return guard.response;
 const items = await listMailCampaigns(mailFilters(req,'campaigns')); return Response.json({items,campaigns:items});
}
