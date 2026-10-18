import { redirect } from "next/navigation";
import { mailPath } from "../components/crm/inbox/mail-path";

export default function InboxPage() {
  redirect(mailPath());
}
