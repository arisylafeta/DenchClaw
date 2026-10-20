import type { MailFilters } from '@/lib/mail-types';
export function mailFilters(req: Request, scope?: MailFilters['view']): MailFilters {
 const params = new URL(req.url).searchParams;
 const filters: MailFilters = {};
 for (const key of ['q','from','to','identity','campaign','thread','person','direction','transport','purpose','state','event','since','until'] as const) {
  const value = params.get(key); if (value) Object.assign(filters,{[key]:value});
 }
 filters.showInternal = params.get('showInternal') === 'true';
 filters.crmOnly = scope !== 'campaigns' && params.get('crmOnly') === 'true';
 return filters;
}
