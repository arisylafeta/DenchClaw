"use client";

import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { PluginKey } from "@tiptap/pm/state";
import { ProfileAvatar } from "../workspace/profile-avatar";

/** `@` addresses an agent in a group chat; files and tables use `#`. */
export const agentMentionPluginKey = new PluginKey("chatAgentMention");
export type MentionAgent = { handle: string; name: string; profile: string };
export type AgentMentionListRef = { onKeyDown: (props: { event: KeyboardEvent }) => boolean };

/** Everyone first when the query is empty or prefixes "all"; then members whose handle or name starts with the query. */
export function filterAgents(agents: readonly MentionAgent[], query: string): MentionAgent[] {
  const needle = query.trim().toLowerCase();
  const everyone: MentionAgent = { handle: "all", name: "Everyone in this chat", profile: "" };
  const matches = agents.filter((agent) => agent.handle.toLowerCase().startsWith(needle) || agent.name.toLowerCase().startsWith(needle));
  return [...("all".startsWith(needle) && agents.length > 1 ? [everyone] : []), ...matches];
}

const AgentMentionList = forwardRef<AgentMentionListRef, { items: MentionAgent[]; command: (agent: MentionAgent) => void }>(function AgentMentionList({ items, command }, ref) {
  const [selected, setSelected] = useState(0);
  useEffect(() => setSelected(0), [items]);
  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }) => {
      if (!items.length) return false;
      if (event.key === "ArrowDown") { setSelected((selected + 1) % items.length); return true; }
      if (event.key === "ArrowUp") { setSelected((selected + items.length - 1) % items.length); return true; }
      if (event.key === "Enter" || event.key === "Tab") { command(items[Math.min(selected, items.length - 1)]); return true; }
      return false;
    },
  }));
  if (!items.length) return <div role="status" className="rounded-2xl px-3 py-2 text-xs text-[var(--color-text-muted)] shadow-lg bg-[var(--color-surface)]">No matching agent</div>;
  return <div role="listbox" aria-label="Agents" className="min-w-56 max-w-80 rounded-2xl bg-[var(--color-surface)] p-1 shadow-lg">
    {items.map((agent, index) => <button key={agent.handle} type="button" role="option" aria-selected={index === selected} onMouseDown={(event) => event.preventDefault()} onClick={() => command(agent)} onMouseEnter={() => setSelected(index)}
      className={`flex w-full items-center gap-2.5 rounded-2xl px-2.5 py-1.5 text-left select-none ${index === selected ? "bg-neutral-400/15" : ""}`}>
      {agent.profile ? <ProfileAvatar name={agent.profile} className="h-5 w-5" /> : <span aria-hidden className="flex h-5 w-5 items-center justify-center text-xs">@</span>}
      <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{agent.name}</span><span className="block truncate text-xs text-[var(--color-text-muted)]">@{agent.handle}</span></span>
    </button>)}
  </div>;
});

function Popup({ items, command, clientRect, listRef }: { items: MentionAgent[]; command: (agent: MentionAgent) => void; clientRect: (() => DOMRect | null) | null; listRef: React.RefObject<AgentMentionListRef | null> }) {
  const el = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const rect = clientRect?.();
    if (!el.current || !rect) return;
    const node = el.current;
    node.style.position = "fixed"; node.style.left = `${rect.left}px`; node.style.zIndex = "100";
    const room = window.innerHeight - rect.bottom;
    if (room < (node.offsetHeight || 160) + 8) { node.style.bottom = `${window.innerHeight - rect.top + 4}px`; node.style.top = "auto"; }
    else { node.style.top = `${rect.bottom + 4}px`; node.style.bottom = "auto"; }
  }, [clientRect, items]);
  return createPortal(<div ref={el}><AgentMentionList ref={listRef as React.RefObject<AgentMentionListRef>} items={items} command={command} /></div>, document.body);
}

/** Tiptap suggestion renderer for `@agent`. The list comes from a ref so the room roster can change without rebuilding the editor. */
export function createAgentMentionRenderer() {
  return () => {
    let container: HTMLDivElement | null = null;
    let root: ReturnType<typeof import("react-dom/client").createRoot> | null = null;
    const listRef: { current: AgentMentionListRef | null } = { current: null };
    let latest: { items: MentionAgent[]; command: (agent: MentionAgent) => void; clientRect: (() => DOMRect | null) | null } | null = null;
    const draw = () => { if (root && latest) root.render(<Popup items={latest.items} command={latest.command} clientRect={latest.clientRect} listRef={listRef} />); };
    const close = () => { root?.unmount(); container?.remove(); container = null; root = null; latest = null; };
    type Props = { items: MentionAgent[]; command: (agent: MentionAgent) => void; clientRect?: (() => DOMRect | null) | null };
    return {
      onStart: (props: Props) => {
        container = document.createElement("div"); document.body.appendChild(container);
        latest = { items: props.items, command: props.command, clientRect: props.clientRect ?? null };
        void import("react-dom/client").then(({ createRoot }) => { if (!container) return; root = createRoot(container); draw(); });
      },
      onUpdate: (props: Props) => { latest = { items: props.items, command: props.command, clientRect: props.clientRect ?? null }; draw(); },
      onKeyDown: (props: { event: KeyboardEvent }) => {
        if (props.event.key === "Escape") { close(); return true; }
        const handled = listRef.current?.onKeyDown(props) ?? false;
        if (handled) props.event.stopImmediatePropagation();
        return handled;
      },
      onExit: close,
    };
  };
}
