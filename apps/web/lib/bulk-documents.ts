/** Documents of a bulk listing: files, links and wanted documents, with a lifecycle. Safe for client and server. */
export const DOC_STATES = ["needed", "requested", "received", "draft", "sent", "signed"] as const;
export type DocState = (typeof DOC_STATES)[number];
export const DOC_DIRECTIONS = ["received", "sent", "prepared"] as const;
export type DocDirection = (typeof DOC_DIRECTIONS)[number];

export const STATE_LABEL: Record<DocState, string> = {
  needed: "Needed", requested: "Requested", received: "Received", draft: "Draft", sent: "Sent", signed: "Signed",
};
export const DIRECTION_LABEL: Record<DocDirection, string> = { received: "Received", sent: "Sent", prepared: "Prepared by us" };

export type ListingDocument = {
  id: string;
  title: string;
  doc_type: string;
  state: DocState;
  direction: DocDirection;
  /** True when the bytes are stored here and can be opened or downloaded. */
  has_file: boolean;
  file_name: string | null;
  content_type: string | null;
  byte_size: number | null;
  url: string | null;
  note: string | null;
  source_label: string | null;
  source_date: string | null;
  visibility: "teaser" | "after_nda" | "after_loi" | "never";
  created_at: string;
};

/** Where a document sits on the page: still wanted, received from someone, or made and sent by us. */
export function documentSection(doc: Pick<ListingDocument, "state" | "direction">): "needed" | "received" | "ours" {
  if (doc.state === "needed" || doc.state === "requested") return "needed";
  return doc.direction === "received" ? "received" : "ours";
}

export type DocInput = {
  title?: string;
  doc_type?: string;
  state?: DocState;
  direction?: DocDirection;
  url?: string | null;
  note?: string | null;
  visibility?: ListingDocument["visibility"];
  source_label?: string | null;
  source_date?: string | null;
};

const safeUrl = (value: unknown): string | null | "bad" => {
  if (value === null || value === "") return null;
  if (typeof value !== "string") return "bad";
  try { return ["https:", "http:"].includes(new URL(value).protocol) ? value : "bad"; } catch { return "bad"; }
};

/** Checks a JSON body for creating or editing a document. Types come from the registry. */
export function parseDocInput(body: unknown, documentTypes: string[], creating: boolean): { value: DocInput } | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "Body must be an object." };
  const input = body as Record<string, unknown>;
  const out: DocInput = {};
  if ("title" in input) {
    if (typeof input.title !== "string" || !input.title.trim()) return { error: "title is required." };
    out.title = input.title.trim().slice(0, 300);
  } else if (creating) return { error: "title is required." };
  if ("doc_type" in input) {
    if (typeof input.doc_type !== "string" || !documentTypes.includes(input.doc_type)) return { error: `doc_type must be one of: ${documentTypes.join(", ")}.` };
    out.doc_type = input.doc_type;
  }
  if ("state" in input) {
    if (!DOC_STATES.includes(input.state as DocState)) return { error: `state must be one of: ${DOC_STATES.join(", ")}.` };
    out.state = input.state as DocState;
  }
  if ("direction" in input) {
    if (!DOC_DIRECTIONS.includes(input.direction as DocDirection)) return { error: `direction must be one of: ${DOC_DIRECTIONS.join(", ")}.` };
    out.direction = input.direction as DocDirection;
  }
  if ("url" in input) {
    const url = safeUrl(input.url);
    if (url === "bad") return { error: "url must be an http or https link." };
    out.url = url;
  }
  for (const key of ["note", "source_label"] as const) {
    if (key in input) {
      if (input[key] !== null && typeof input[key] !== "string") return { error: `${key} must be text.` };
      out[key] = typeof input[key] === "string" && (input[key] as string).trim() ? (input[key] as string).trim() : null;
    }
  }
  if ("source_date" in input) {
    const date = input.source_date;
    if (date !== null && (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date))) return { error: "source_date must be YYYY-MM-DD." };
    out.source_date = date as string | null;
  }
  if ("visibility" in input) {
    if (!["teaser", "after_nda", "after_loi", "never"].includes(input.visibility as string)) return { error: "visibility must be teaser, after_nda, after_loi or never." };
    out.visibility = input.visibility as DocInput["visibility"];
  }
  return { value: out };
}
