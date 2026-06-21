import { queryPg } from "../postgres";

export type PostgresPeopleListItem = {
  id: string;
  name: string | null;
  email: string | null;
  company_name: string | null;
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
    job_title: string | null;
  }>(
    `select p.id,
            p.full_name as name,
            p.email,
            c.name as company_name,
            p.job_title
       from crm_people p
       left join crm_companies c on c.id = p.company_id
      order by p.updated_at desc nulls last
      limit $1`,
    [params.limit],
  );

  return {
    people: rows.map((row) => ({
      id: row.id,
      name: row.name,
      email: row.email,
      company_name: row.company_name,
      job_title: row.job_title,
    })),
  };
}

