import { queryPg, withPgTransaction } from "../postgres";

export type PostgresPhotoSyncPerson = {
	id: string;
	email: string;
	avatar_url: string | null;
};

export async function getPostgresPhotoSyncPeople(): Promise<PostgresPhotoSyncPerson[]> {
	return queryPg<PostgresPhotoSyncPerson>(
		`select id, email, avatar_url
		   from crm_people
		  where email is not null
		    and btrim(email) <> ''`,
	);
}

export async function updatePostgresAvatarUrls(
	updates: Array<{ id: string; avatarUrl: string }>,
): Promise<number> {
	if (updates.length === 0) {return 0;}

	return withPgTransaction(async (tx) => {
		let updated = 0;
		for (const row of updates) {
			const result = await tx.query(
				`update crm_people
				    set avatar_url = $2,
				        updated_at = now()
				  where id = $1
				    and avatar_url is distinct from $2`,
				[row.id, row.avatarUrl],
			);
			updated += result.rowCount ?? 0;
		}
		return updated;
	});
}
