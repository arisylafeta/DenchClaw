import { Bot, BookOpen, Brain, Bug, CircleHelp, Clock, Code, Database, Eye, FileText, FolderSearch, GitBranch, Globe, ListChecks, MessagesSquare, Package, Pencil, Plug, Search, Terminal, Wrench, type LucideIcon } from "lucide-react";
import type { ToolSegment } from "@/lib/hermes-chat/reducer";
import { asRecord } from "@/lib/hermes-chat/events";

export interface ToolDescription { label: string; icon: LucideIcon }
type Args = Record<string, unknown>;
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const short = (value: string, max = 36) => value.length > max ? `${value.slice(0, max - 1)}…` : value;
const baseName = (path: string) => short(path.replace(/\/+$/, "").split("/").pop() || path);
const host = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return short(url); } };
const humanize = (name: string) => name.replace(/^mcp__/, "").replace(/[_-]+/g, " ").trim();
const tense = (running: boolean, past: string, present: string) => running ? present : past;
const pick = (args: Args, ...keys: string[]) => { for (const key of keys) { const value = text(args[key]); if (value) return value; } return ""; };
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** Programs seen in real traces, mapped to a safe description. The command line itself is never shown. */
function shell(command: string, running: boolean): ToolDescription {
  const stripped = command.replace(/^\s*(?:cd\s+[^;&|]+(?:&&|;)\s*)?(?:(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*)/, "");
  const words = stripped.split(/\s+/).filter(Boolean);
  const program = (words[0] ?? "").split("/").pop() ?? "";
  const git = ["status", "diff", "log", "commit", "push", "pull", "checkout", "merge", "worktree", "add", "fetch", "branch", "rebase", "stash", "show"];
  const runners = ["install", "build", "test", "run", "exec", "dev", "lint"];
  const subOf = (known: string[]) => words.slice(1, 6).find(word => known.includes(word)) ?? "";
  const node = ["python3", "python"].includes(program) ? "Python" : ["node", "bun", "tsx", "deno"].includes(program) ? "JavaScript" : "";
  if (node) return { label: tense(running, `Ran a ${node} script`, `Running a ${node} script`), icon: Code };
  if (program === "git") return { label: tense(running, `Ran git${subOf(git) ? ` ${subOf(git)}` : ""}`, `Running git${subOf(git) ? ` ${subOf(git)}` : ""}`), icon: GitBranch };
  if (program === "psql") return { label: tense(running, "Queried the database", "Querying the database"), icon: Database };
  if (["pnpm", "npm", "yarn", "bunx", "npx"].includes(program)) {
    const sub = subOf(runners);
    const known = sub ? ` ${sub}` : "";
    return { label: tense(running, `Ran ${program}${known}`, `Running ${program}${known}`), icon: Package };
  }
  if (program === "gh") return { label: tense(running, "Used GitHub", "Using GitHub"), icon: GitBranch };
  if (program === "vercel") return { label: tense(running, "Used Vercel", "Using Vercel"), icon: Package };
  if (["curl", "wget"].includes(program)) return { label: tense(running, "Made an HTTP request", "Making an HTTP request"), icon: Globe };
  if (program === "jq") return { label: tense(running, "Processed JSON", "Processing JSON"), icon: Terminal };
  if (["mkdir", "cp", "mv", "rm", "ls", "cat", "touch", "chmod", "tar", "unzip", "find"].includes(program)) return { label: tense(running, "Managed files", "Managing files"), icon: FolderSearch };
  if (["systemctl", "journalctl", "service"].includes(program)) return { label: tense(running, "Checked a service", "Checking a service"), icon: Terminal };
  if (program === "hermes") return { label: tense(running, "Ran the Hermes CLI", "Running the Hermes CLI"), icon: Terminal };
  if (["date", "pwd", "echo", "printf", "set", "command", "true", "sleep", "wc", "head", "tail"].includes(program)) return { label: tense(running, "Ran a quick command", "Running a quick command"), icon: Terminal };
  return { label: tense(running, "Ran a shell command", "Running a shell command"), icon: Terminal };
}

const MCP_SERVERS: Record<string, string> = { supabase: "Supabase", sentry: "Sentry", denchclaw: "the CRM", exa: "the web", reports: "reports", code: "code" };
/** MCP and meta-wrapped tools: mcp__<server>__<tool>. */
function mcp(name: string, args: Args, running: boolean): ToolDescription {
  const [, server = "", ...rest] = name.split("__");
  const tool = rest.join("__");
  const inFiles = tense(running, "Read", "Reading");
  if (server === "supabase") {
    if (tool === "execute_sql") return { label: tense(running, "Queried Supabase", "Querying Supabase"), icon: Database };
    if (tool === "query_logs" || tool === "get_logs") return { label: tense(running, "Read Supabase logs", "Reading Supabase logs"), icon: Database };
    return { label: tense(running, "Checked Supabase", "Checking Supabase"), icon: Database };
  }
  if (server === "sentry") {
    if (tool.includes("search")) return { label: tense(running, "Searched Sentry errors", "Searching Sentry errors"), icon: Bug };
    return { label: tense(running, "Looked up Sentry details", "Looking up Sentry details"), icon: Bug };
  }
  if (server === "code") {
    if (tool === "grep") { const query = pick(args, "pattern", "query"); return { label: `${tense(running, "Searched", "Searching")} code${query ? ` for “${short(query, 32)}”` : ""}`, icon: Search }; }
    if (tool === "read_multiple_files") { const paths = args.paths; return { label: `${inFiles} ${plural(Array.isArray(paths) ? paths.length : 1, "file", "files")}`, icon: FileText }; }
    const path = pick(args, "path", "file", "file_path");
    return { label: `${inFiles} ${path ? baseName(path) : "a file"}`, icon: FileText };
  }
  if (server === "exa") { const query = pick(args, "query"); return { label: `${tense(running, "Searched", "Searching")} the web${query ? ` for “${short(query, 40)}”` : ""}`, icon: Search }; }
  if (server === "denchclaw") {
    if (tool.includes("people")) return { label: tense(running, "Searched CRM people", "Searching CRM people"), icon: Search };
    if (tool.includes("compan")) return { label: tense(running, "Searched CRM companies", "Searching CRM companies"), icon: Search };
    return { label: tense(running, "Queried the CRM", "Querying the CRM"), icon: Database };
  }
  if (server === "reports") return { label: tool.includes("write") ? tense(running, "Wrote a report", "Writing a report") : tense(running, "Read report context", "Reading report context"), icon: FileText };
  if (server === "open_preview") return { label: tense(running, "Opened a preview", "Opening a preview"), icon: Eye };
  const label = MCP_SERVERS[server] ?? humanize(server);
  return { label: `${tense(running, "Used", "Using")} ${label}${tool ? ` · ${humanize(tool)}` : ""}`, icon: Plug };
}

function describeNamed(name: string, args: Args, running: boolean): ToolDescription {
  if (name.startsWith("mcp__")) return mcp(name, args, running);
  const path = pick(args, "path", "file", "filepath", "file_path");
  switch (name) {
    case "terminal": case "bash": case "shell": return shell(pick(args, "command"), running);
    case "execute_code": return { label: tense(running, "Ran a code snippet", "Running a code snippet"), icon: Code };
    case "read_file": case "read": return { label: `${tense(running, "Read", "Reading")} ${path ? baseName(path) : "a file"}`, icon: FileText };
    case "list_files": case "ls": return { label: tense(running, "Listed files", "Listing files"), icon: FolderSearch };
    case "search_files": case "glob": case "grep": {
      const pattern = pick(args, "pattern", "query");
      const content = text(args.target) !== "files" && name !== "glob";
      const where = path ? ` in ${baseName(path)}` : "";
      if (!pattern) return { label: tense(running, "Searched files", "Searching files"), icon: FolderSearch };
      return { label: `${tense(running, "Searched", "Searching")} ${content ? "for" : "files matching"} “${short(pattern, 32)}”${where}`, icon: FolderSearch };
    }
    case "write_file": return { label: `${tense(running, "Wrote", "Writing")} ${path ? baseName(path) : "a file"}`, icon: Pencil };
    case "patch": case "apply_patch": case "edit_file": case "file_edit": case "edit": case "write": case "multi_edit": {
      const body = text(args.patch);
      const files = [...body.matchAll(/^\*\*\* (Update|Add|Delete) File: (.+)$/gm)].map(match => ({ kind: match[1], path: match[2].trim() }));
      if (files.length > 1) return { label: `${tense(running, "Edited", "Editing")} ${plural(files.length, "file", "files")}`, icon: Pencil };
      const only = files[0];
      const target = only?.path ?? path;
      const verb = only?.kind === "Add" ? ["Created", "Creating"] : only?.kind === "Delete" ? ["Deleted", "Deleting"] : ["Edited", "Editing"];
      return { label: `${tense(running, verb[0], verb[1])} ${target ? baseName(target) : "a file"}`, icon: Pencil };
    }
    case "web_search": { const query = pick(args, "query"); return { label: `${tense(running, "Searched", "Searching")} the web${query ? ` for “${short(query, 40)}”` : ""}`, icon: Search }; }
    case "web_extract": case "web_fetch": case "fetch": case "browser_navigate": {
      const urls = Array.isArray(args.urls) ? args.urls.map(text).filter(Boolean) : [pick(args, "url")].filter(Boolean);
      return { label: `${tense(running, "Read", "Reading")} ${urls[0] ? host(urls[0]) : "a page"}${urls.length > 1 ? ` +${urls.length - 1} more` : ""}`, icon: Globe };
    }
    case "browser_exec": return { label: tense(running, "Used the browser", "Using the browser"), icon: Globe };
    case "open_preview": return { label: tense(running, "Opened a preview", "Opening a preview"), icon: Eye };
    case "read_preview": case "drive_preview": return { label: tense(running, "Looked at a preview", "Looking at a preview"), icon: Eye };
    case "vision_analyze": return { label: tense(running, "Looked at an image", "Looking at an image"), icon: Eye };
    case "session_search": return { label: tense(running, "Searched past chats", "Searching past chats"), icon: MessagesSquare };
    case "skill_view": { const skill = pick(args, "name"); return { label: `${tense(running, "Loaded", "Loading")} ${skill ? `the ${short(skill, 28)} skill` : "a skill"}`, icon: BookOpen }; }
    case "skills_list": return { label: tense(running, "Listed skills", "Listing skills"), icon: BookOpen };
    case "skill_manage": return { label: tense(running, "Updated skills", "Updating skills"), icon: BookOpen };
    case "todo": case "todo_list": return { label: tense(running, "Updated the task list", "Updating the task list"), icon: ListChecks };
    case "memory": return { label: tense(running, "Used memory", "Using memory"), icon: Brain };
    case "clarify": return { label: tense(running, "Asked you a question", "Asking you a question"), icon: CircleHelp };
    case "cronjob": case "cronjob_manage": return { label: tense(running, "Managed a scheduled job", "Managing a scheduled job"), icon: Clock };
    case "process": case "process_manage": {
      const action = pick(args, "action");
      return { label: action === "kill" ? tense(running, "Stopped a background process", "Stopping a background process") : tense(running, "Checked a background process", "Checking a background process"), icon: Terminal };
    }
    case "tool_search": case "tool_describe": return { label: tense(running, "Looked up available tools", "Looking up available tools"), icon: Wrench };
    case "setup_mcp": case "manage_connections": return { label: tense(running, "Set up connections", "Setting up connections"), icon: Plug };
    case "rebattery_granola": return { label: tense(running, "Collected Granola notes", "Collecting Granola notes"), icon: FileText };
    case "herdr_bridge": return { label: tense(running, "Controlled Herdr", "Controlling Herdr"), icon: Terminal };
    case "discord": case "discord_admin": return { label: tense(running, "Used Discord", "Using Discord"), icon: MessagesSquare };
    case "delegate_task": {
      const action = pick(args, "action");
      if (action === "steer") return { label: tense(running, "Steered a subagent", "Steering a subagent"), icon: Bot };
      if (action === "list") return { label: tense(running, "Checked on subagents", "Checking on subagents"), icon: Bot };
      const tasks = Array.isArray(args.tasks) ? args.tasks.length : 0;
      if (tasks > 1) return { label: `${tense(running, "Delegated", "Delegating")} ${tasks} tasks`, icon: Bot };
      return { label: tense(running, "Delegated a task", "Delegating a task"), icon: Bot };
    }
    default: return { label: `${tense(running, "Used", "Using")} ${humanize(name)}`, icon: Wrench };
  }
}

/** Short plain-English line for a tool call. Commands, arguments and results are never shown. */
export function describeTool(tool: Pick<ToolSegment, "name" | "args" | "status">): ToolDescription {
  const running = tool.status === "running";
  const args = asRecord(tool.args);
  if (tool.name === "tool_call" && Array.isArray(args.calls) && args.calls.length) {
    const inner = args.calls.map(call => { const record = asRecord(call); return describeNamed(text(record.name) || text(record.tool), asRecord(record.arguments), running); });
    const labels = [...new Set(inner.map(item => item.label))];
    if (labels.length === 1) return { label: inner.length > 1 ? `${labels[0]} ×${inner.length}` : labels[0], icon: inner[0].icon };
    return { label: `${tense(running, "Ran", "Running")} ${plural(inner.length, "tool call", "tool calls")}`, icon: inner[0].icon };
  }
  return describeNamed(tool.name, args, running);
}
