import { withPgTransaction } from "../postgres";

export type PostgresPhotoSyncPerson = {
	id: string;
	email: string;
	avatar_url: string | null;
};

// DEPRECATED: crm_people.avatar_url was dropped. Stubs preserved for callers.
export async function getPostgresPhotoSyncPeople(): Promise<PostgresPhotoSyncPerson[]> {
	return [];
}

export async function updatePostgresAvatarUrls(
	updates: Array<{ id: string; avatarUrl: string }>,
): Promise<number> {
	if (updates.length === 0) {return 0;}

	return withPgTransaction(async (_tx) => {
		return 0;
	});
}
