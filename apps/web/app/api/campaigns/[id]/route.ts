export async function GET(req: Request, context: {params: Promise<{id:string}>}) {
 const {id} = await context.params;
 const url = new URL(`/api/mail/campaigns/${id}`,req.url); url.search = new URL(req.url).search;
 return Response.redirect(url,308);
}
