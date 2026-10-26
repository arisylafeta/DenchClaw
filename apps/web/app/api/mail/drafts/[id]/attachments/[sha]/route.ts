import { currentUser } from '@/lib/auth';
import { draftAttachmentFile } from '@/lib/crm-postgres/mail';
import { SHA256, fileResponse, readDraftFile } from '@/lib/mail-draft-files';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
/** One file stored with a draft, by checksum. Download by default; `?inline=1` only shows safe image types (thumbnails). */
export async function GET(req: Request, context: {params: Promise<{id:string; sha:string}>}) {
 const user = await currentUser();
 if (!user) return Response.json({error:'Unauthorized'},{status:401});
 const {id, sha} = await context.params;
 if (!SHA256.test(sha)) return Response.json({error:'Not found'},{status:404});
 const entry = await draftAttachmentFile(id,user.id,sha);
 const file = entry ? await readDraftFile(entry,sha) : null;
 if (!file) return Response.json({error:'Not found'},{status:404});
 return fileResponse(file, new URL(req.url).searchParams.get('inline') === '1');
}
