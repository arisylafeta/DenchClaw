export async function GET(req: Request, context: {params: Promise<{threadId:string}>}) {
 const {threadId} = await context.params;
 const url = new URL(`/api/mail/threads/${threadId}`,req.url); url.search = new URL(req.url).search;
 return Response.redirect(url,308);
}
