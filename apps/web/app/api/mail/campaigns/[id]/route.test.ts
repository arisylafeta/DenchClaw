import {expect,it,vi} from 'vitest';
const {readMailCampaign}=vi.hoisted(()=>({readMailCampaign:vi.fn()}));
vi.mock('@/lib/bulk-trades-route',()=>({guardBulkTrades:async()=>({user:{id:'owner'}})}));
vi.mock('@/lib/crm-postgres/mail',()=>({readMailCampaign}));
import {GET} from './route';
it('passes active mail filters into the campaign detail reader',async()=>{
 readMailCampaign.mockResolvedValue({id:'campaign',delivery_rows:[],links:[]});
 const response=await GET(new Request('http://localhost/api/mail/campaigns/campaign?crmOnly=true&event=clicked&identity=ari'),{params:Promise.resolve({id:'campaign'})});
 expect(response.status).toBe(200);
 expect(readMailCampaign).toHaveBeenCalledWith('campaign',{crmOnly:true,event:'clicked',identity:'ari'});
});
