import {expect,it,vi} from 'vitest';
const {readMailCampaign,listMailCampaigns}=vi.hoisted(()=>({readMailCampaign:vi.fn(),listMailCampaigns:vi.fn()}));
vi.mock('@/lib/bulk-trades-route',()=>({guardBulkTrades:async()=>({user:{id:'owner'}})}));
vi.mock('@/lib/crm-postgres/mail',()=>({readMailCampaign,listMailCampaigns}));
import {GET} from './route';
import {GET as GET_LIST} from '../route';
it('ignores CRM-only while preserving active campaign detail filters',async()=>{
 readMailCampaign.mockResolvedValue({id:'campaign',delivery_rows:[],links:[]});
 const response=await GET(new Request('http://localhost/api/mail/campaigns/campaign?crmOnly=true&event=clicked&identity=ari'),{params:Promise.resolve({id:'campaign'})});
 expect(response.status).toBe(200);
 expect(readMailCampaign).toHaveBeenCalledWith('campaign',{crmOnly:false,event:'clicked',identity:'ari'});
});
it('ignores CRM-only for the campaign list too',async()=>{
 listMailCampaigns.mockResolvedValue([{id:'campaign'}]);
 const response=await GET_LIST(new Request('http://localhost/api/mail/campaigns?crmOnly=true&event=opened'));
 expect(response.status).toBe(200);
 expect(listMailCampaigns).toHaveBeenCalledWith({crmOnly:false,event:'opened'});
});
