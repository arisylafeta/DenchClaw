export async function GET(req: Request) {
 const url = new URL(`/api/mail/messages`,req.url); url.search = new URL(req.url).search;
 return Response.redirect(url,308);
}
