import { currentUser } from "@/lib/auth";
import { accessErrorResponse, changeSharing } from "@/lib/conversation-access";
import { authorizeNativeConversation } from "@/lib/hermes-native";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{key:string}> };
export async function GET(_req: Request, context: Context) {
 const actor = await currentUser(); if (!actor) {return Response.json({error:"Unauthorized"},{status:401});}
 try { return Response.json({access:(await authorizeNativeConversation(actor,(await context.params).key)).access}); }
 catch(error) { return accessErrorResponse(error); }
}
export async function PATCH(req: Request, context: Context) {
 const actor = await currentUser(); if (!actor) {return Response.json({error:"Unauthorized"},{status:401});}
 try {
  const body = await req.json();
  if (!body || Object.keys(body).length !== 1 || !["private","team"].includes(body.visibility)) {return Response.json({error:"invalid_visibility"},{status:400});}
  const key = (await context.params).key;
  await authorizeNativeConversation(actor,key,"share");
  const access = await changeSharing(actor,key,body.visibility);
  // Exact read-back also detects concurrent deletion or revocation.
  const verified = (await authorizeNativeConversation(actor,key)).access;
  if (verified.visibility !== access.visibility) {return Response.json({error:"sharing_changed"},{status:409});}
  return Response.json({access:verified});
 } catch(error) { return accessErrorResponse(error); }
}
