import { queryPg } from "@/lib/postgres";
import { findObjectDir, resolveWorkspaceRoot } from "@/lib/workspace";

export type PostgresObjectContext = {
	objectName: string;
	objectId: string;
	objectDir: string;
	workspaceRoot: string | null;
};

const canonicalTableByObjectName: Record<string, string> = {
	people: "crm_people",
	company: "crm_companies",
	companies: "crm_companies",
	email_thread: "crm_email_threads",
	email_message: "crm_email_messages",
	calendar_event: "crm_calendar_events",
	interaction: "crm_interactions",
};

export async function resolvePostgresObjectContext(objectName: string): Promise<PostgresObjectContext | null> {
	const objectDir = findObjectDir(objectName);
	if (!objectDir) return null;

	const rows = await queryPg<{ id: string }>(
		`select id from crm_objects where name = $1 limit 1`,
		[objectName],
	);
	if (!rows[0]?.id) return null;

	return {
		objectName,
		objectId: rows[0].id,
		objectDir,
		workspaceRoot: resolveWorkspaceRoot(),
	};
}

export async function verifyPostgresEntryExists(objectName: string, entryId: string): Promise<boolean> {
	const objectRows = await queryPg<{ entity_table: string | null }>(
		`select entity_table from crm_objects where name = $1 limit 1`,
		[objectName],
	);
	const entityTable = objectRows[0]?.entity_table ?? canonicalTableByObjectName[objectName.trim().toLowerCase()];
	if (!entityTable || !/^crm_[a-z0-9_]+$/.test(entityTable)) return false;

	const rows = await queryPg<{ cnt: number }>(
		`select count(*)::int as cnt
		 from ${entityTable}
		 where id = $1`,
		[entryId],
	);
	return (rows[0]?.cnt ?? 0) > 0;
}

export async function lookupPostgresRegisteredDocument(objectId: string, entryId: string): Promise<{ file_path: string; title: string | null } | null> {
	const rows = await queryPg<{ file_path: string; title: string | null }>(
		`select file_path, title
		 from crm_documents
		 where entry_id = $1 and parent_object_id = $2
		 order by updated_at desc
		 limit 1`,
		[entryId, objectId],
	);
	return rows[0] ?? null;
}

export async function registerPostgresEntryDocument(
	objectId: string,
	entryId: string,
	title: string,
	workspaceRelativePath: string,
): Promise<void> {
	await queryPg(
		`update crm_documents
		 set title = $1,
		     file_path = $2,
		     parent_object_id = $3,
		     entry_id = $4,
		     updated_at = now()
		 where entry_id = $4 and parent_object_id = $3`,
		[title, workspaceRelativePath, objectId, entryId],
	);

	await queryPg(
		`update crm_documents
		 set title = $1,
		     parent_object_id = $2,
		     entry_id = $3,
		     updated_at = now()
		 where file_path = $4 and (entry_id is null or entry_id = $3)`,
		[title, objectId, entryId, workspaceRelativePath],
	);

	await queryPg(
		`insert into crm_documents (title, file_path, parent_object_id, entry_id)
		 select $1, $2, $3, $4
		 where not exists (
		   select 1 from crm_documents
		   where (entry_id = $4 and parent_object_id = $3)
		      or file_path = $2
		 )`,
		[title, workspaceRelativePath, objectId, entryId],
	);
}

export async function lookupPostgresEntryIdByPath(workspaceRelativePath: string): Promise<string | null> {
	const rows = await queryPg<{ entry_id: string | null }>(
		`select entry_id
		 from crm_documents
		 where file_path = $1
		 limit 1`,
		[workspaceRelativePath],
	);
	return rows[0]?.entry_id ?? null;
}
