"use client";

import { useMemo, useState, useCallback, useRef, useEffect } from "react";
import {
  DndContext,
  DragOverlay,
  closestCorners,
  PointerSensor,
  useSensor,
  useSensors,
  useDroppable,
  useDraggable,
  type DragStartEvent,
  type DragEndEvent,
} from "@dnd-kit/core";
import { formatWorkspaceFieldValue } from "@/lib/workspace-cell-format";
import { parseTagsValue } from "@/lib/parse-tags";
import { displayObjectName } from "@/lib/object-display-name";
import { ActionButton, type ActionConfig } from "./action-button";
import { useToast } from "./toast";
import { UrlFavicon } from "./url-favicon";
import { getFirstEntryUrlPreview } from "./workspace-url-preview";

type Field = {
  id: string;
  name: string;
  type: string;
  enum_values?: string[];
  enum_colors?: string[];
  related_object_name?: string;
  default_value?: string;
};

type Status = {
  id: string;
  name: string;
  color?: string;
  sort_order?: number;
};

type ObjectKanbanProps = {
  objectName: string;
  fields: Field[];
  entries: Record<string, unknown>[];
  statuses: Status[];
  members?: Array<{ id: string; name: string }>;
  relationLabels?: Record<string, Record<string, string>>;
  /** Optional outer grouping rendered as independently expandable Kanban accordions. */
  accordionGroupFieldName?: string;
  onEntryClick?: (entryId: string) => void;
  onRefresh?: () => void;
};

// --- Helpers ---

/** Safely convert unknown (DuckDB) value to string for display. */
function safeString(val: unknown): string {
	if (val == null) {return "";}
	if (typeof val === "object") {return JSON.stringify(val);}
	if (typeof val === "string") {return val;}
	if (typeof val === "number" || typeof val === "boolean" || typeof val === "bigint") {return String(val);}
	return "";
}

function parseRelationValue(value: string | null | undefined): string[] {
  if (!value) {return [];}
  const trimmed = value.trim();
  if (!trimmed) {return [];}
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {return parsed.map(String).filter(Boolean);}
    } catch {
      // not valid JSON
    }
  }
  return [trimmed];
}


function columnDropId(sectionKey: string, columnName: string): string {
  return `column:${encodeURIComponent(sectionKey)}:${encodeURIComponent(columnName)}`;
}

function parseColumnDropId(id: string): { sectionKey: string; columnName: string } | null {
  if (!id.startsWith("column:")) {return null;}
  const separator = id.indexOf(":", "column:".length);
  if (separator < 0) {return null;}
  return {
    sectionKey: decodeURIComponent(id.slice("column:".length, separator)),
    columnName: decodeURIComponent(id.slice(separator + 1)),
  };
}

export type KanbanAccordionSection = {
  key: string;
  label: string;
  entries: Record<string, unknown>[];
};

export function buildKanbanAccordionSections(
  entries: Record<string, unknown>[],
  fieldName: string,
  labels: Record<string, string> = {},
): KanbanAccordionSection[] {
  const entriesByKey = new Map<string, Record<string, unknown>[]>();
  for (const entry of entries) {
    const key = parseRelationValue(safeString(entry[fieldName]))[0] ?? "_ungrouped";
    const groupedEntries = entriesByKey.get(key) ?? [];
    groupedEntries.push(entry);
    entriesByKey.set(key, groupedEntries);
  }

  const sections: KanbanAccordionSection[] = [];
  for (const [key, label] of Object.entries(labels)) {
    const groupedEntries = entriesByKey.get(key);
    if (!groupedEntries) {continue;}
    sections.push({ key, label, entries: groupedEntries });
    entriesByKey.delete(key);
  }
  for (const [key, groupedEntries] of entriesByKey) {
    sections.push({
      key,
      label: key === "_ungrouped" ? "No project" : labels[key] ?? key,
      entries: groupedEntries,
    });
  }
  return sections;
}

function getEntryTitle(entry: Record<string, unknown>, fields: Field[]): string {
  const titleField = fields.find(
    (f) =>
      f.name.toLowerCase().includes("name") ||
      f.name.toLowerCase().includes("title"),
  );
  return titleField
    ? safeString(entry[titleField.name]) || "Untitled"
    : safeString(entry[fields[0]?.name]) || "Untitled";
}

// --- Draggable Card ---

function DraggableCard({
  entry,
  fields,
  members,
  relationLabels,
  onEntryClick,
  objectName,
  onToast,
}: {
  entry: Record<string, unknown>;
  fields: Field[];
  members?: Array<{ id: string; name: string }>;
  relationLabels?: Record<string, Record<string, string>>;
  onEntryClick?: (entryId: string) => void;
  objectName?: string;
  onToast?: (message: string, opts?: { type?: "success" | "error" | "info" }) => void;
}) {
  const entryId = safeString(entry.entry_id) || "";
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: entryId,
    data: { entry },
  });

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      onClick={(e) => {
        // Only open if not dragging
        if (!isDragging && onEntryClick) {
          e.stopPropagation();
          onEntryClick(entryId);
        }
      }}
      className="rounded-lg p-3 mb-2 transition-all duration-100 cursor-grab active:cursor-grabbing select-none"
      style={{
        background: "var(--color-surface)",
        border: `1px solid ${isDragging ? "var(--color-accent)" : "var(--color-border)"}`,
        opacity: isDragging ? 0.4 : 1,
        transform: isDragging ? "scale(1.02)" : undefined,
      }}
    >
      <CardContent
        entry={entry}
        fields={fields}
        members={members}
        relationLabels={relationLabels}
        objectName={objectName}
        onToast={onToast}
      />
    </div>
  );
}

// --- Card content (shared between draggable + overlay) ---

function parseActionConfig(defaultValue: string | null | undefined): ActionConfig[] {
  if (!defaultValue) return [];
  try {
    const parsed = JSON.parse(defaultValue);
    if (parsed && Array.isArray(parsed.actions)) return parsed.actions;
  } catch { /* ignore */ }
  return [];
}

function CardContent({
  entry,
  fields,
  members,
  relationLabels,
  objectName,
  onToast,
}: {
  entry: Record<string, unknown>;
  fields: Field[];
  members?: Array<{ id: string; name: string }>;
  relationLabels?: Record<string, Record<string, string>>;
  objectName?: string;
  onToast?: (message: string, opts?: { type?: "success" | "error" | "info" }) => void;
}) {
  const title = getEntryTitle(entry, fields);
  const titleUrlPreview = getFirstEntryUrlPreview(entry, fields);

  const actionFields = fields.filter((f) => f.type === "action");
  const dataFields = fields.filter((f) => f.type !== "action");

  const displayFields = dataFields
    .filter(
      (f) =>
        f.type !== "richtext" &&
        entry[f.name] !== null &&
        entry[f.name] !== undefined &&
        entry[f.name] !== "",
    )
    .slice(0, 4);

  const titleField = fields.find(
    (f) =>
      f.name.toLowerCase().includes("name") ||
      f.name.toLowerCase().includes("title"),
  );

  return (
    <>
      <div
        className="flex items-center gap-2 mb-1.5 min-w-0"
        style={{ color: "var(--color-text)" }}
      >
        {titleUrlPreview?.faviconUrl && (
          <UrlFavicon
            src={titleUrlPreview.faviconUrl}
            className="w-4 h-4 rounded-[4px] shrink-0"
          />
        )}
        <div className="text-sm font-medium truncate min-w-0">
          {title}
        </div>
      </div>
      <div className="space-y-1">
        {displayFields
          .filter((f) => f !== titleField)
          .slice(0, 3)
          .map((field) => {
            const val = entry[field.name];
            if (!val) {return null;}

            let displayVal = safeString(val);
            if (field.type === "user") {
              const member = members?.find((m) => m.id === displayVal);
              if (member) {displayVal = member.name;}
            } else if (field.type === "relation") {
              const fieldLabels = relationLabels?.[field.name];
              const ids = parseRelationValue(displayVal);
              const labels = ids.map((id) => fieldLabels?.[id] ?? id);
              displayVal = labels.join(", ");
            }

            const tags = field.type === "tags" ? parseTagsValue(val) : [];

            return (
              <div key={field.id} className="flex items-center gap-1.5 text-xs">
                <span style={{ color: "var(--color-text-muted)" }}>
                  {field.name}:
                </span>
                {field.type === "enum" ? (
                  <EnumBadgeMini
                    value={safeString(val)}
                    enumValues={field.enum_values}
                    enumColors={field.enum_colors}
                  />
                ) : field.type === "tags" ? (
                  <span className="flex items-center gap-0.5 flex-wrap">
                    {tags.slice(0, 3).map((tag) => {
                      const fmt = formatWorkspaceFieldValue(tag);
                      const isLink = fmt.kind === "link" && fmt.href;
                      const showFavicon = fmt.linkType === "url" && !!fmt.faviconUrl;
                      return isLink ? (
                        <a
                          key={tag}
                          href={fmt.href!}
                          target={fmt.linkType === "url" || fmt.linkType === "file" ? "_blank" : undefined}
                          rel={fmt.linkType === "url" || fmt.linkType === "file" ? "noopener noreferrer" : undefined}
                          onClick={(e) => e.stopPropagation()}
                          className="inline-flex items-center gap-1 px-1.5 py-0 rounded text-[11px] font-medium hover:underline underline-offset-2 max-w-[220px]"
                          style={{ background: "rgba(148, 163, 184, 0.12)", color: "var(--color-accent)" }}
                        >
                          {showFavicon && (
                            <UrlFavicon
                              src={fmt.faviconUrl!}
                              className="w-3 h-3 rounded-[2px] shrink-0"
                            />
                          )}
                          <span className="min-w-0 truncate">{fmt.text}</span>
                        </a>
                      ) : (
                        <span
                          key={tag}
                          className="inline-flex items-center px-1.5 py-0 rounded text-[11px] font-medium"
                          style={{ background: "rgba(148, 163, 184, 0.12)", color: "var(--color-text-muted)" }}
                        >
                          {tag}
                        </span>
                      );
                    })}
                    {tags.length > 3 && (
                      <span style={{ color: "var(--color-text-muted)", opacity: 0.6 }}>+{tags.length - 3}</span>
                    )}
                  </span>
                ) : field.type === "relation" ? (
                  <span
                    className="truncate inline-flex items-center gap-0.5"
                    style={{ color: "#60a5fa" }}
                  >
                    <svg
                      width="8"
                      height="8"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="flex-shrink-0"
                      style={{ opacity: 0.5 }}
                    >
                      <path d="M7 7h10v10" />
                      <path d="M7 17 17 7" />
                    </svg>
                    {displayVal}
                  </span>
                ) : (
                  <span
                    className="whitespace-pre-line line-clamp-2"
                    style={{ color: "var(--color-text)" }}
                  >
                    {displayVal}
                  </span>
                )}
              </div>
            );
          })}
      </div>
      {objectName && actionFields.length > 0 && (
        <div className="flex items-center gap-1 mt-2 pt-1.5" style={{ borderTop: "1px solid var(--color-border)" }} onClick={(e) => e.stopPropagation()}>
          {actionFields.flatMap((af) =>
            parseActionConfig(af.default_value).map((action) => (
              <ActionButton
                key={`${af.id}_${action.id}`}
                action={action}
                entryId={String(entry.entry_id ?? "")}
                objectName={objectName}
                fieldId={af.id}
                compact
                onToast={onToast}
              />
            )),
          )}
        </div>
      )}
    </>
  );
}

function EnumBadgeMini({
  value,
  enumValues,
  enumColors,
}: {
  value: string;
  enumValues?: string[];
  enumColors?: string[];
}) {
  const idx = enumValues?.indexOf(value) ?? -1;
  const color = idx >= 0 && enumColors ? enumColors[idx] : "#94a3b8";

  return (
    <span
      className="inline-flex items-center px-1.5 py-0 rounded text-[11px] font-medium"
      style={{
        background: `${color}20`,
        color: color,
      }}
    >
      {value}
    </span>
  );
}

// --- Droppable Column ---

function DroppableColumn({
  columnName,
  droppableId,
  color,
  items,
  cardFields,
  members,
  relationLabels,
  onEntryClick,
  isOver,
  groupFieldId,
  objectName,
  onRefresh,
  onToast,
}: {
  columnName: string;
  droppableId: string;
  color: string;
  items: Record<string, unknown>[];
  cardFields: Field[];
  members?: Array<{ id: string; name: string }>;
  relationLabels?: Record<string, Record<string, string>>;
  onEntryClick?: (entryId: string) => void;
  isOver: boolean;
  groupFieldId?: string;
  objectName: string;
  onRefresh?: () => void;
  onToast?: (message: string, opts?: { type?: "success" | "error" | "info" }) => void;
}) {
  const { setNodeRef } = useDroppable({ id: droppableId });
  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState(columnName);
  const [renaming, setRenaming] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingName && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingName]);

  const handleRename = useCallback(async () => {
    const trimmed = nameValue.trim();
    if (!trimmed || trimmed === columnName || !groupFieldId) {
      setEditingName(false);
      setNameValue(columnName);
      return;
    }

    setRenaming(true);
    try {
      const res = await fetch(
        `/api/workspace/objects/${encodeURIComponent(objectName)}/fields/${encodeURIComponent(groupFieldId)}/enum-rename`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ oldValue: columnName, newValue: trimmed }),
        },
      );
      if (res.ok) {
        onRefresh?.();
      } else {
        setNameValue(columnName);
      }
    } catch {
      setNameValue(columnName);
    } finally {
      setRenaming(false);
      setEditingName(false);
    }
  }, [nameValue, columnName, groupFieldId, objectName, onRefresh]);

  return (
    <div
      ref={setNodeRef}
      className="flex-shrink-0 flex flex-col rounded-xl transition-colors duration-150"
      style={{
        width: "280px",
        background: isOver ? "var(--color-surface)" : "var(--color-bg)",
        border: `1px solid ${isOver ? "var(--color-accent)" : "var(--color-border)"}`,
      }}
    >
      {/* Column header */}
      <div
        className="flex items-center gap-2 px-3 py-2.5 border-b"
        style={{ borderColor: "var(--color-border)" }}
      >
        <span
          className="w-2.5 h-2.5 rounded-full flex-shrink-0"
          style={{ background: color }}
        />
        {editingName ? (
          <input
            ref={inputRef}
            value={nameValue}
            onChange={(e) => setNameValue(e.target.value)}
            onBlur={handleRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") {void handleRename();}
              if (e.key === "Escape") {
                setNameValue(columnName);
                setEditingName(false);
              }
            }}
            disabled={renaming}
            className="text-sm font-medium flex-1 bg-transparent outline-none rounded px-1 -mx-1"
            style={{
              color: "var(--color-text)",
              border: "1px solid var(--color-accent)",
            }}
          />
        ) : (
          <span
            className="text-sm font-medium flex-1 cursor-text rounded px-1 -mx-1 hover:bg-[var(--color-surface-hover)] transition-colors"
            style={{ color: "var(--color-text)" }}
            onDoubleClick={() => {
              if (groupFieldId) {
                setNameValue(columnName);
                setEditingName(true);
              }
            }}
            title={groupFieldId ? "Double-click to rename" : undefined}
          >
            {columnName}
          </span>
        )}
        <span
          className="text-xs px-1.5 py-0.5 rounded-full"
          style={{
            background: "var(--color-surface)",
            color: "var(--color-text-muted)",
          }}
        >
          {items.length}
        </span>
      </div>

      {/* Cards */}
      <div className="flex-1 overflow-y-auto p-2" style={{ minHeight: "80px" }}>
        {items.length === 0 ? (
          <div
            className="flex items-center justify-center py-8 rounded-lg border border-dashed text-xs transition-colors"
            style={{
              borderColor: isOver ? "var(--color-accent)" : "var(--color-border)",
              color: isOver ? "var(--color-accent)" : "var(--color-text-muted)",
            }}
          >
            {isOver ? "Drop here" : "No entries"}
          </div>
        ) : (
          items.map((entry, idx) => (
            <DraggableCard
              key={safeString(entry.entry_id) || String(idx)}
              entry={entry}
              fields={cardFields}
              members={members}
              relationLabels={relationLabels}
              onEntryClick={onEntryClick}
              objectName={objectName}
              onToast={onToast}
            />
          ))
        )}
      </div>
    </div>
  );
}

// --- Kanban Board ---

export function ObjectKanban({
  objectName,
  fields,
  entries,
  statuses,
  members,
  relationLabels,
  accordionGroupFieldName,
  onEntryClick,
  onRefresh,
}: ObjectKanbanProps) {
  const showToast = useToast();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [overColumnId, setOverColumnId] = useState<string | null>(null);
  const [expandedSections, setExpandedSections] = useState<Set<string>>(() => new Set());
  // Optimistic local entries for instant drag feedback
  const [localEntries, setLocalEntries] = useState(entries);

  // Sync when parent entries change
  useEffect(() => {
    setLocalEntries(entries);
  }, [entries]);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    }),
  );

  // Find the grouping field
  const groupField = useMemo(() => {
    const statusField = fields.find(
      (f) =>
        f.type === "enum" &&
        f.name.toLowerCase().includes("status"),
    );
    if (statusField) {return statusField;}
    return fields.find((f) => f.type === "enum") ?? null;
  }, [fields]);

  const accordionField = useMemo(
    () => accordionGroupFieldName
      ? fields.find((field) => field.name === accordionGroupFieldName) ?? null
      : null,
    [accordionGroupFieldName, fields],
  );

  const accordionSections = useMemo(
    () => accordionField
      ? buildKanbanAccordionSections(
          localEntries,
          accordionField.name,
          relationLabels?.[accordionField.name],
        )
      : [],
    [accordionField, localEntries, relationLabels],
  );
  const accordionSectionKeys = accordionSections.map((section) => section.key).join(" ");

  useEffect(() => {
    if (!accordionField || accordionSections.length === 0) {return;}
    setExpandedSections((current) => {
      const visibleKeys = new Set(accordionSections.map((section) => section.key));
      const next = new Set(Array.from(current).filter((key) => visibleKeys.has(key)));
      if (next.size === 0) {next.add(accordionSections[0].key);}
      if (next.size === current.size && Array.from(next).every((key) => current.has(key))) {
        return current;
      }
      return next;
    });
  // The stable key list prevents task moves from resetting the user's expansion choices.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accordionField, accordionSectionKeys]);

  // Determine columns
  const columns = useMemo(() => {
    if (statuses.length > 0) {
      return statuses.map((s) => ({
        name: s.name,
        color: s.color ?? "#94a3b8",
      }));
    }
    if (groupField?.enum_values) {
      return groupField.enum_values.map((v, i) => ({
        name: v,
        color: groupField.enum_colors?.[i] ?? "#94a3b8",
      }));
    }
    const unique = new Set<string>();
    for (const e of localEntries) {
      const val = groupField ? e[groupField.name] : undefined;
      if (val) {unique.add(safeString(val));}
    }
    return Array.from(unique).map((v) => ({ name: v, color: "#94a3b8" }));
  }, [statuses, groupField, localEntries]);

  const groupEntriesByColumn = useCallback((sectionEntries: Record<string, unknown>[]) => {
    const groups: Record<string, Record<string, unknown>[]> = {};
    for (const col of columns) {groups[col.name] = [];}
    groups["_ungrouped"] = [];

    for (const entry of sectionEntries) {
      const val = groupField ? safeString(entry[groupField.name]) : "";
      if (groups[val]) {
        groups[val].push(entry);
      } else {
        groups["_ungrouped"].push(entry);
      }
    }
    return groups;
  }, [columns, groupField]);

  const grouped = useMemo(
    () => groupEntriesByColumn(localEntries),
    [groupEntriesByColumn, localEntries],
  );

  const cardFields = fields.filter((f) => f !== groupField && f !== accordionField);

  // Active drag entry for overlay
  const activeEntry = useMemo(() => {
    if (!activeId) {return null;}
    return localEntries.find((e) => String(e.entry_id) === activeId) ?? null;
  }, [activeId, localEntries]);

  // Handle drag start
  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveId(String(event.active.id));
  }, []);

  // Track which column is being hovered
  const handleDragOver = useCallback((event: { over: { id: string | number } | null }) => {
    const overId = event.over?.id ? String(event.over.id) : null;
    if (overId?.startsWith("column:")) {
      setOverColumnId(overId);
    } else {
      setOverColumnId(null);
    }
  }, []);

  // Handle drag end - move card to new column
  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      setActiveId(null);
      setOverColumnId(null);

      const { active, over } = event;
      if (!over || !groupField) {return;}

      const target = parseColumnDropId(String(over.id));
      if (!target) {return;}

      const entryId = String(active.id);
      const entry = localEntries.find((e) => String(e.entry_id) === entryId);
      if (!entry) {return;}

      const currentValue = safeString(entry[groupField.name]);
      const currentAccordionValue = accordionField
        ? parseRelationValue(safeString(entry[accordionField.name]))[0] ?? "_ungrouped"
        : "_all";
      const targetAccordionValue = accordionField ? target.sectionKey : "_all";
      if (currentValue === target.columnName && currentAccordionValue === targetAccordionValue) {return;}

      const changedFields: Record<string, unknown> = {
        [groupField.name]: target.columnName,
      };
      if (accordionField && currentAccordionValue !== targetAccordionValue) {
        changedFields[accordionField.name] = targetAccordionValue === "_ungrouped"
          ? ""
          : targetAccordionValue;
      }

      const applyFields = (candidate: Record<string, unknown>, values: Record<string, unknown>) =>
        String(candidate.entry_id) === entryId ? { ...candidate, ...values } : candidate;
      setLocalEntries((prev) => prev.map((candidate) => applyFields(candidate, changedFields)));

      try {
        const res = await fetch(
          `/api/workspace/objects/${encodeURIComponent(objectName)}/entries/${encodeURIComponent(entryId)}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ fields: changedFields }),
          },
        );
        if (res.ok) {
          onRefresh?.();
        } else {
          const previousFields: Record<string, unknown> = { [groupField.name]: currentValue };
          if (accordionField) {previousFields[accordionField.name] = entry[accordionField.name] ?? "";}
          setLocalEntries((prev) => prev.map((candidate) => applyFields(candidate, previousFields)));
        }
      } catch {
        const previousFields: Record<string, unknown> = { [groupField.name]: currentValue };
        if (accordionField) {previousFields[accordionField.name] = entry[accordionField.name] ?? "";}
        setLocalEntries((prev) => prev.map((candidate) => applyFields(candidate, previousFields)));
      }
    },
    [accordionField, groupField, localEntries, objectName, onRefresh],
  );

  if (!groupField) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-3">
        <p className="text-sm" style={{ color: "var(--color-text-muted)" }}>
          No enum field found for kanban grouping in{" "}
          <span className="font-medium" style={{ color: "var(--color-text)" }}>
            {displayObjectName(objectName)}
          </span>
        </p>
      </div>
    );
  }

  const renderBoard = (
    boardGroups: Record<string, Record<string, unknown>[]>,
    sectionKey: string,
  ) => (
    <div className="flex gap-4 overflow-x-auto pb-4 px-1" style={{ minHeight: "320px" }}>
      {columns.map((col) => {
        const droppableId = columnDropId(sectionKey, col.name);
        return (
          <DroppableColumn
            key={droppableId}
            columnName={col.name}
            droppableId={droppableId}
            color={col.color}
            items={boardGroups[col.name] ?? []}
            cardFields={cardFields}
            members={members}
            relationLabels={relationLabels}
            onEntryClick={onEntryClick}
            isOver={overColumnId === droppableId}
            groupFieldId={groupField.id}
            objectName={objectName}
            onRefresh={onRefresh}
            onToast={showToast}
          />
        );
      })}

      {boardGroups["_ungrouped"]?.length > 0 && (
        <div
          className="flex-shrink-0 flex flex-col rounded-xl"
          style={{
            width: "280px",
            background: "var(--color-bg)",
            border: "1px dashed var(--color-border)",
          }}
        >
          <div
            className="flex items-center gap-2 px-3 py-2.5 border-b"
            style={{ borderColor: "var(--color-border)" }}
          >
            <span className="text-sm font-medium" style={{ color: "var(--color-text-muted)" }}>
              Ungrouped
            </span>
            <span
              className="text-xs px-1.5 py-0.5 rounded-full"
              style={{ background: "var(--color-surface)", color: "var(--color-text-muted)" }}
            >
              {boardGroups["_ungrouped"].length}
            </span>
          </div>
          <div className="flex-1 overflow-y-auto p-2">
            {boardGroups["_ungrouped"].map((entry, idx) => (
              <DraggableCard
                key={safeString(entry.entry_id) || String(idx)}
                entry={entry}
                fields={cardFields}
                members={members}
                relationLabels={relationLabels}
                onEntryClick={onEntryClick}
                objectName={objectName}
                onToast={showToast}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
    >
      {accordionField ? (
        <div className="flex flex-col gap-3 px-1 pb-4">
          {accordionSections.map((section) => {
            const isExpanded = expandedSections.has(section.key);
            return (
              <section
                key={section.key}
                className="rounded-xl border overflow-hidden"
                style={{ borderColor: "var(--color-border)", background: "var(--color-bg)" }}
              >
                <button
                  type="button"
                  aria-expanded={isExpanded}
                  onClick={() => setExpandedSections((current) => {
                    const next = new Set(current);
                    if (next.has(section.key)) {next.delete(section.key);} else {next.add(section.key);}
                    return next;
                  })}
                  className="w-full flex items-center gap-2 px-4 py-3 text-left cursor-pointer transition-colors hover:bg-[var(--color-surface-hover)]"
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className={`shrink-0 transition-transform ${isExpanded ? "rotate-90" : ""}`}
                    aria-hidden
                  >
                    <path d="m9 18 6-6-6-6" />
                  </svg>
                  <span className="font-medium flex-1" style={{ color: "var(--color-text)" }}>
                    {section.label}
                  </span>
                  <span
                    className="text-xs px-2 py-0.5 rounded-full"
                    style={{ background: "var(--color-surface)", color: "var(--color-text-muted)" }}
                  >
                    {section.entries.length} {section.entries.length === 1 ? "task" : "tasks"}
                  </span>
                </button>
                {isExpanded && (
                  <div className="border-t px-3 pt-3" style={{ borderColor: "var(--color-border)" }}>
                    {renderBoard(groupEntriesByColumn(section.entries), section.key)}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      ) : (
        renderBoard(grouped, "_all")
      )}

      {/* Drag overlay - floating card that follows cursor */}
      <DragOverlay dropAnimation={null}>
        {activeEntry ? (
          <div
            className="rounded-lg p-3 shadow-xl"
            style={{
              width: "260px",
              background: "var(--color-surface)",
              border: "1px solid var(--color-accent)",
              transform: "rotate(2deg)",
            }}
          >
            <CardContent
              entry={activeEntry}
              fields={cardFields}
              members={members}
              objectName={objectName}
              relationLabels={relationLabels}
              onToast={showToast}
            />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
