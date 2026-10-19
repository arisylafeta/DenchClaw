import { gatewayCommand, type GatewayRouteContext } from "../gateway-command";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function POST(req: Request, context: GatewayRouteContext) { return gatewayCommand(req, context, "fast"); }
