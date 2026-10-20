import { randomUUID } from "node:crypto";
import { queryPg } from "../postgres";
import type { DocInput, ListingDocument } from "../bulk-documents";

const COLUMNS = `id, title, doc_type, state, direction, (content is not null) as has_file, file_name, content_type, byte_size::int as byte_size,
  url, note, source_label, to_char(source_date, 'YYYY-MM-DD') as source_date, visibility, created_at::text as created_at`;

export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;

export async function listDocuments(listingId: string): Promise<ListingDocument[]> {
  return queryPg<ListingDocument>(
    `select ${COLUMNS} from crm_bulk_listing_documents where bulk_listing_id = $1 order by created_at desc, id`, [listingId]);
}

async function listingExists(id: string) {
  return (await queryPg("select 1 from crm_bulk_listings where id = $1", [id])).length > 0;
}

/** Notes the change in the listing's Story, so the timeline shows documents arriving. */
async function story(listingId: string, title: string, userId: string | null, docId: string) {
  await queryPg(
    `insert into crm_bulk_listing_activity (bulk_listing_id, kind, title, data, actor_user_id) values ($1, 'document', $2, $3::jsonb, $4)`,
    [listingId, title.slice(0, 300), JSON.stringify({ document_id: docId }), userId]);
}

export async function addDocument(
  listingId: string,
  input: DocInput & { title: string },
  file: { name: string; type: string | null; content: Buffer } | null,
  userId: string,
): Promise<ListingDocument | null> {
  if (!(await listingExists(listingId))) return null;
  const id = `bdoc_${randomUUID()}`;
  const state = input.state ?? (file ? "received" : input.url ? "received" : "needed");
  await queryPg(
    `insert into crm_bulk_listing_documents (id, bulk_listing_id, title, doc_type, state, direction, url, note, visibility, source_label, source_date,
       file_name, file_type, content_type, byte_size, content, uploaded_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::date, $12, $13, $14, $15, $16, $17)`,
    [id, listingId, input.title, input.doc_type ?? "Other", state, input.direction ?? "received", input.url ?? null, input.note ?? null,
      input.visibility ?? "never", input.source_label ?? null, input.source_date ?? null,
      file?.name ?? null, file ? (input.doc_type ?? "Other") : null, file?.type ?? null, file?.content.length ?? null, file?.content ?? null, userId]);
  await story(listingId, state === "needed" || state === "requested" ? `Document wanted: ${input.title}` : `Document added: ${input.title}`, userId, id);
  const [row] = await queryPg<ListingDocument>(`select ${COLUMNS} from crm_bulk_listing_documents where id = $1`, [id]);
  return row;
}

const EDITABLE = ["title", "doc_type", "state", "direction", "url", "note", "visibility", "source_label", "source_date"] as const;

export async function updateDocument(listingId: string, id: string, patch: DocInput): Promise<ListingDocument | null> {
  const keys = EDITABLE.filter((key) => key in patch);
  if (keys.length) {
    const rows = await queryPg(
      `update crm_bulk_listing_documents set ${keys.map((key, i) => `${key} = $${i + 3}${key === "source_date" ? "::date" : ""}`).join(", ")}, updated_at = now()
       where id = $1 and bulk_listing_id = $2 returning id`,
      [id, listingId, ...keys.map((key) => patch[key] ?? null)]);
    if (!rows.length) return null;
  }
  const [row] = await queryPg<ListingDocument>(`select ${COLUMNS} from crm_bulk_listing_documents where id = $1 and bulk_listing_id = $2`, [id, listingId]);
  return row ?? null;
}

/** Attaches bytes to an existing document (a needed one becomes received). */
export async function attachFile(listingId: string, id: string, file: { name: string; type: string | null; content: Buffer }, userId: string): Promise<ListingDocument | null> {
  const rows = await queryPg<{ title: string }>(
    `update crm_bulk_listing_documents set content = $3, file_name = $4, content_type = $5, byte_size = $6, file_type = doc_type,
       state = case when state in ('needed', 'requested') then 'received' else state end, uploaded_by = $7, updated_at = now()
     where id = $1 and bulk_listing_id = $2 returning title`,
    [id, listingId, file.content, file.name, file.type, file.content.length, userId]);
  if (!rows.length) return null;
  await story(listingId, `Document received: ${rows[0].title}`, userId, id);
  const [row] = await queryPg<ListingDocument>(`select ${COLUMNS} from crm_bulk_listing_documents where id = $1`, [id]);
  return row;
}

export async function deleteDocument(listingId: string, id: string): Promise<boolean> {
  return (await queryPg("delete from crm_bulk_listing_documents where id = $1 and bulk_listing_id = $2 returning id", [id, listingId])).length > 0;
}

export async function documentFile(listingId: string, id: string) {
  const [row] = await queryPg<{ file_name: string; content: Buffer }>(
    "select file_name, content from crm_bulk_listing_documents where id = $1 and bulk_listing_id = $2 and content is not null", [id, listingId]);
  return row ?? null;
}
