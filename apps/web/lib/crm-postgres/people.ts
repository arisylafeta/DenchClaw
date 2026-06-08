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
            p.strength_score,
            p.last_interaction_at,
            p.avatar_url,
            p.job_title
       from crm_people p
       left join crm_companies c on c.id = p.company_id
      order by p.strength_score desc nulls last,
               p.last_interaction_at desc nulls last,
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
