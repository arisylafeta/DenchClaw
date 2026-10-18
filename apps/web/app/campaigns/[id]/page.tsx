import { redirect } from "next/navigation";
import { mailPath } from "../../components/crm/inbox/mail-path";

export default async function CampaignPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(mailPath("campaigns", id));
}
