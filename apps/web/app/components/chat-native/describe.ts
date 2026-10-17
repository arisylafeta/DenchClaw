import { Bot, FileText, FolderSearch, Globe, Pencil, Search, Terminal, Wrench, type LucideIcon } from "lucide-react";
import type { ToolSegment } from "@/lib/hermes-chat/reducer";
import { asRecord } from "@/lib/hermes-chat/events";
import { toolCategory, toolTarget } from "@/lib/hermes-chat/run-summary";

export interface ToolDescription { label: string; icon: LucideIcon }
const short = (value: string, max = 36) => value.length > max ? `${value.slice(0, max - 1)}…` : value;
const baseName = (path: string) => short(path.replace(/\/+$/, "").split("/").pop() || path);
const host = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return short(url); } };
const humanize = (name: string) => name.replace(/[_-]+/g, " ").trim();

/** A short plain-English line for a tool call. Commands, arguments and results are never shown. */
export function describeTool(tool: Pick<ToolSegment, "name" | "args" | "status">): ToolDescription {
  const running = tool.status === "running";
  const target = toolTarget(tool);
  const query = short(String(asRecord(tool.args).query ?? asRecord(tool.args).search_term ?? asRecord(tool.args).pattern ?? ""), 40);
  switch (toolCategory(tool.name)) {
    case "run": return { label: running ? "Running a shell command" : "Ran a shell command", icon: Terminal };
    case "edit": return { label: `${running ? "Editing" : tool.name.includes("write") ? "Wrote" : "Edited"} ${target ? baseName(target) : "a file"}`, icon: Pencil };
    case "explore":
      if (tool.name === "read_file" || tool.name === "read") return { label: `${running ? "Reading" : "Read"} ${target ? baseName(target) : "a file"}`, icon: FileText };
      if (tool.name === "list_files" || tool.name === "ls") return { label: running ? "Listing files" : "Listed files", icon: FolderSearch };
      return { label: running ? "Searching files" : "Searched files", icon: FolderSearch };
    case "search": return { label: `${running ? "Searching" : "Searched"} ${tool.name === "grep" ? "the code" : "the web"}${query ? ` for “${query}”` : ""}`, icon: Search };
    case "fetch": return { label: `${running ? "Opening" : "Opened"} ${target ? host(target) : "a page"}`, icon: Globe };
    case "delegate": return { label: running ? "Delegating a task" : "Delegated a task", icon: Bot };
    default: return { label: `${running ? "Using" : "Used"} ${humanize(tool.name)}`, icon: Wrench };
  }
}
