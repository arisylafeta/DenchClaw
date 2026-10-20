import { currentUser } from '@/lib/auth';
import { downloadMailAttachment } from '@/lib/mail-attachments';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// Always a download, never rendered in the page: attachments are untrusted files.
export async function GET(req: Request, context: {params: Promise<{id:string}>}) {
 const user = await currentUser();
 if (!user) return Response.json({error:'Unauthorized'},{status:401});
 const {id} = await context.params;
 const name = new URL(req.url).searchParams.get('name') ?? '';
 const result = await downloadMailAttachment(id,user.id,name);
 if ('error' in result) return Response.json({error:result.error},{status:result.status});
 const safe = result.filename.replace(/[^\x20-\x7e]|["\\]/g,'_');
 return new Response(new Uint8Array(result.bytes),{headers:{
  'content-type':'application/octet-stream',
  'content-disposition':`attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(result.filename)}`,
  'x-content-type-options':'nosniff','cache-control':'private, no-store',
 }});
}
