import { currentUser } from "@/lib/auth";
import { accessErrorResponse } from "@/lib/conversation-access";
import { authorizeNativeConversation } from "@/lib/hermes-native";
import { resolveAgentBackend } from '@/lib/agent-backend';
import { parseConversationKey } from '@/lib/hermes-conversations';
import { readRoomTrace } from '@/lib/hermes-gateway/room-trace';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// Revalidate the CRM actor and conversation access before room discovery.
export async function GET(req: Request, context: { params: Promise<{ key: string }> }) {
  const actor = await currentUser(); if (!actor) {return Response.json({error:"Unauthorized"},{status:401});}
  if (resolveAgentBackend() !== 'hermes') {return Response.json({ error: 'Hermes is not enabled' }, { status: 404 });}
  try {
    const key = (await context.params).key;
    await authorizeNativeConversation(actor,key);
    const identity = parseConversationKey(key);
    if (identity.kind !== 'group') {return Response.json({ error: 'Group required' }, { status: 400 });}
    const query = new URL(req.url).searchParams;
    const member = query.get('member'); const turn = query.get('turn');
    if (!member || !turn || member.length > 256 || turn.length > 256) {return Response.json({ error: 'Invalid turn' }, { status: 400 });}
    const trace = await readRoomTrace(key, member, turn,actor);
    return Response.json({ trace: trace && query.get('summary') === '1' ? { startedAt: trace.startedAt, completedAt: trace.completedAt, steps: trace.steps } : trace }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return accessErrorResponse(error); }
}
