import { currentUser } from '@/lib/auth';
import { listMailAttachments } from '@/lib/mail-attachments';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function GET(_req: Request, context: {params: Promise<{id:string}>}) {
 const user = await currentUser();
 if (!user) return Response.json({error:'Unauthorized'},{status:401});
 const {id} = await context.params;
 const data = await listMailAttachments(id,user.id);
 return data ? Response.json(data) : Response.json({error:'Not found'},{status:404});
}
