import { expect, it } from 'vitest';
import { GET } from './route';
it('permanently redirects to the unified mail API and preserves filters',async () => {
 const response = await GET(new Request('http://localhost/api/old?q=battery'), {params:Promise.resolve({id:'example'})});
 expect(response.status).toBe(308);
 expect(response.headers.get('location')).toBe('http://localhost/api/mail/campaigns/example/activity?q=battery');
});
