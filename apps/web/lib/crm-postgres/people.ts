import { queryPg } from "../postgres";

export type PostgresPeopleListItem = {
  id: string;
  name: string | null;
  email: string | null;
  company_name: string | null;
  strength_score: number | null;
  last_interaction_at: string | null;
  avatar_url: string | null;
  job_title: string | null;
};

export async function getPostgresPeople(
  params: { limit: number },
): Promise<{ people: PostgresPeopleListItem[] }> {
  const columns = await loadPeopleColumns();
  const strengthScore = columns.has("strength_score") ? "p.strength_score" : "null::numeric";
  const lastInteractionAt = columns.has("last_interaction_at") ? "p.last_interaction_at" : "null::timestamptz";
  const jobTitle = columns.has("job_title") ? "p.job_title" : "null::text";
  const sortByStrength = columns.has("strength_score") ? "p.strength_score desc nulls last," : "";
  const sortByLastInteraction = columns.has("last_interaction_at") ? "p.last_interaction_at desc nulls last," : "";

  const rows = await queryPg<{
    id: string;
    name: string | null;
    email: string | null;
    company_name: string | null;
    strength_score: number | string | null;
    last_interaction_at: string | Date | null;
    avatar_url: string | null;
    job_title: string | null;
  }>(
    `select p.id,
            p.full_name as name,
            p.email,
            c.name as company_name,
            ${strengthScore} as strength_score,
            ${lastInteractionAt} as last_interaction_at,
            p.avatar_url,
            ${jobTitle} as job_title
       from crm_people p
       left join crm_companies c on c.id = p.company_id
      order by ${sortByStrength}
               ${sortByLastInteraction}
               p.updated_at desc nulls last
      limit $1`,
    [params.limit],
  );

  return {
    people: rows.map((row) => {
      const strength = row.strength_score == null ? null : Number(row.strength_score);
      return {
        id: row.id,
        name: row.name,
        email: row.email,
        company_name: row.company_name,
        strength_score: Number.isFinite(strength) ? strength : null,
        last_interaction_at: row.last_interaction_at == null ? null : new Date(row.last_interaction_at).toISOString(),
        avatar_url: row.avatar_url,
        job_title: row.job_title,
      };
    }),
  };
}

async function loadPeopleColumns(): Promise<Set<string>> {
  const rows = await queryPg<{ column_name: string }>(
    `select column_name
       from information_schema.columns
      where table_schema = current_schema()
        and table_name = 'crm_people'`,
  );
  return new Set(rows.map((row) => row.column_name));
}
