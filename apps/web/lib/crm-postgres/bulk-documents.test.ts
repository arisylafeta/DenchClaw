import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Runs only against a disposable database: scripts/rebattery/crm-test-db.sh up prints the URL.
const TEST_URL = process.env.BULK_TRADES_TEST_DATABASE_URL;

describe.skipIf(!TEST_URL)("bulk listing documents", () => {
  let pg: typeof import("../postgres");
  let docs: typeof import("./bulk-documents");
  let trades: typeof import("./bulk-trades");
  let details: typeof import("./bulk-trade-details");
  let user: { id: string };
  let demandId: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_URL;
    pg = await import("../postgres");
    docs = await import("./bulk-documents");
    trades = await import("./bulk-trades");
    details = await import("./bulk-trade-details");
    [user] = await pg.queryPg<{ id: string }>(`insert into crm_users (email, display_name, password_hash) values ('docs-' || gen_random_uuid() || '@example.test', 'Alex', 'x') returning id`);
    demandId = `btd_docs_${Date.now()}`;
    await pg.queryPg(`insert into crm_bulk_demand (id, buyer, wants, kind) values ($1, 'Docs Buyer', 'LFP packs', 'standing')`, [demandId]);
  });
  afterAll(async () => { await pg.pgPool.end(); });

  it("wants a document, receives a file for it, and records the moves in the Story", async () => {
    const wanted = await docs.addDocument(demandId, { title: "Toyota datasheet", doc_type: "Datasheet" }, null, user.id);
    expect(wanted).toMatchObject({ state: "needed", has_file: false, doc_type: "Datasheet" });

    const got = await docs.attachFile(demandId, wanted!.id, { name: "toyota.pdf", type: "application/pdf", content: Buffer.from("%PDF-1") }, user.id);
    expect(got).toMatchObject({ state: "received", has_file: true, file_name: "toyota.pdf", byte_size: 6 });
    expect((await docs.documentFile(demandId, wanted!.id))?.content.toString()).toBe("%PDF-1");

    const story = await pg.queryPg<{ title: string }>(`select title from crm_bulk_listing_activity where bulk_listing_id = $1 and kind = 'document' order by id`, [demandId]);
    expect(story.map((row) => row.title)).toEqual(["Document wanted: Toyota datasheet", "Document received: Toyota datasheet"]);
  });

  it("refuses to mark an empty document received, accepts a link, and deletes", async () => {
    const empty = await docs.addDocument(demandId, { title: "Quote", doc_type: "Quote" }, null, user.id);
    await expect(docs.updateDocument(demandId, empty!.id, { state: "received" })).rejects.toMatchObject({ code: "23514" });
    expect(await docs.updateDocument(demandId, empty!.id, { url: "https://example.test/q", state: "received" })).toMatchObject({ state: "received", url: "https://example.test/q" });
    expect(await docs.deleteDocument(demandId, empty!.id)).toBe(true);
    expect(await docs.deleteDocument(demandId, empty!.id)).toBe(false);
  });

  it("keeps the trade file API working on top of documents, for a trade made after the migration", async () => {
    const trade = await trades.createBulkTrade({ title: "Docs trade", trade_kind: "packs", trade_stage: "With buyers" }, user.id);
    const file = await details.recordFile(trade.id, { file_name: "photos.zip", file_type: "Photos", content_type: null, content: Buffer.from("zip") }, { file_type: "Photos", visibility: "never" }, user.id);
    expect(file).toMatchObject({ file_name: "photos.zip", file_type: "Photos", byte_size: 3 });
    const listed = await docs.listDocuments(trade.id);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: file!.id, title: "photos.zip", doc_type: "Photos", state: "received", has_file: true });
    expect((await details.getFileForDownload(trade.id, file!.id))?.content.toString()).toBe("zip");
  });
});
