import {afterEach, describe, expect, it, vi} from 'vitest';
import {getPostHogHealth, runPostHogQuery} from './posthog';
afterEach(() => {vi.unstubAllGlobals();vi.unstubAllEnvs();});
function configure() {vi.stubEnv('POSTHOG_HOST','https://us.posthog.com');vi.stubEnv('POSTHOG_PROJECT_ID','375247');vi.stubEnv('POSTHOG_API_KEY','synthetic-private-token');}
describe('PostHog failure handling', () => {
  it.each([{hasMore:true},{is_partial:true},{error:'secret provider detail'}])('rejects incomplete aggregates %j',async flags=>{
    configure(); vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json({results:[[1]],...flags})));
    await expect(runPostHogQuery('SELECT 1 LIMIT 1')).rejects.toThrow('PostHog response incomplete');
  });
  it('reports health failures without provider body or token',async()=>{
    configure();vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('synthetic-private-token',{status:403})));
    const result=await getPostHogHealth();expect(result.status).toBe('failing');expect(JSON.stringify(result)).not.toContain('synthetic-private-token');
  });
  it('rejects untrusted hosts before fetching',async()=>{
    configure();vi.stubEnv('POSTHOG_HOST','https://attacker.example');const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
    await expect(runPostHogQuery('SELECT 1')).rejects.toThrow('configuration');expect(fetch).not.toHaveBeenCalled();
  });
});
