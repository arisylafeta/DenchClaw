import { WorkspaceShell } from "./workspace/workspace-content";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default function Home() {
  return <WorkspaceShell />;
}
