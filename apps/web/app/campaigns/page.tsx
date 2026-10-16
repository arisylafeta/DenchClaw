import { redirect } from "next/navigation";
import { mailPath } from "../components/crm/inbox/mail-path";

export default function CampaignsPage() {
  redirect(mailPath("campaigns"));
}
