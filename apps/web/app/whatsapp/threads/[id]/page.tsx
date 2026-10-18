import { WhatsappConversation } from "@/app/components/crm/whatsapp-context";
export default async function WhatsappThreadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <WhatsappConversation id={id} />;
}
