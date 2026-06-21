/**
 * Shared types for the CRM inbox components. Keep in sync with
 * /api/crm/inbox/route.ts and /api/crm/inbox/[threadId]/route.ts.
 */

import type { Participant } from "./participant-chips";

export type Thread = {
  id: string;
  subject: string | null;
  last_message_at: string | null;
  message_count: number | null;
  gmail_thread_id: string | null;
  participants: Participant[];
  participant_ids: string[];
  snippet: string | null;
  primary_sender_type: string | null;
  primary_sender_id: string | null;
  primary_sender_name: string | null;
  primary_sender_email: string | null;
};

export type Message = {
  id: string;
  subject: string | null;
  sent_at: string | null;
  preview: string | null;
  body: string | null;
  has_attachments: boolean;
  gmail_message_id: string | null;
  sender_type: string | null;
  from_person_id: string | null;
  from_name?: string | null;
  from_email?: string | null;
  to_person_ids: string[];
  cc_person_ids: string[];
};

export type SenderFilter = "person" | "all" | "automated";
