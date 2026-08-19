export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      account_memberships: {
        Row: {
          account_id: string
          created_at: string
          id: string
          is_primary: boolean
          membership_role: Database["public"]["Enums"]["membership_role"]
          updated_at: string
          user_id: string
        }
        Insert: {
          account_id: string
          created_at?: string
          id?: string
          is_primary?: boolean
          membership_role?: Database["public"]["Enums"]["membership_role"]
          updated_at?: string
          user_id: string
        }
        Update: {
          account_id?: string
          created_at?: string
          id?: string
          is_primary?: boolean
          membership_role?: Database["public"]["Enums"]["membership_role"]
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "account_memberships_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "account_memberships_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      conversation_messages: {
        Row: {
          attachment_content_type: string | null
          attachment_file_name: string | null
          attachment_size_bytes: number | null
          attachment_url: string | null
          body: string
          conversation_id: string
          created_at: string
          deal_document_id: string | null
          id: string
          is_system_seeded: boolean
          message_type: string
          moderation_attempt_count: number | null
          moderation_decided_at: string | null
          moderation_decision_source: string | null
          moderation_failure_code: string | null
          moderation_policy_version: string | null
          moderation_reason_code: string | null
          moderation_reason_text: string | null
          moderation_status: string
          sender_membership_id: string | null
          source_offer_id: string | null
          source_offer_type: string | null
          updated_at: string
        }
        Insert: {
          attachment_content_type?: string | null
          attachment_file_name?: string | null
          attachment_size_bytes?: number | null
          attachment_url?: string | null
          body: string
          conversation_id: string
          created_at?: string
          deal_document_id?: string | null
          id?: string
          is_system_seeded?: boolean
          message_type?: string
          moderation_attempt_count?: number | null
          moderation_decided_at?: string | null
          moderation_decision_source?: string | null
          moderation_failure_code?: string | null
          moderation_policy_version?: string | null
          moderation_reason_code?: string | null
          moderation_reason_text?: string | null
          moderation_status?: string
          sender_membership_id?: string | null
          source_offer_id?: string | null
          source_offer_type?: string | null
          updated_at?: string
        }
        Update: {
          attachment_content_type?: string | null
          attachment_file_name?: string | null
          attachment_size_bytes?: number | null
          attachment_url?: string | null
          body?: string
          conversation_id?: string
          created_at?: string
          deal_document_id?: string | null
          id?: string
          is_system_seeded?: boolean
          message_type?: string
          moderation_attempt_count?: number | null
          moderation_decided_at?: string | null
          moderation_decision_source?: string | null
          moderation_failure_code?: string | null
          moderation_policy_version?: string | null
          moderation_reason_code?: string | null
          moderation_reason_text?: string | null
          moderation_status?: string
          sender_membership_id?: string | null
          source_offer_id?: string | null
          source_offer_type?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      conversations: {
        Row: {
          conversation_type: string
          counterparty_account_id: string
          created_at: string
          id: string
          last_message_at: string | null
          last_message_preview: string | null
          listing_id: string
          status: string
          supplier_account_id: string
          updated_at: string
        }
        Insert: {
          conversation_type: string
          counterparty_account_id: string
          created_at?: string
          id?: string
          last_message_at?: string | null
          last_message_preview?: string | null
          listing_id: string
          status?: string
          supplier_account_id: string
          updated_at?: string
        }
        Update: {
          conversation_type?: string
          counterparty_account_id?: string
          created_at?: string
          id?: string
          last_message_at?: string | null
          last_message_preview?: string | null
          listing_id?: string
          status?: string
          supplier_account_id?: string
          updated_at?: string
        }
        Relationships: []
      }
      account_profiles_private: {
        Row: {
          account_id: string
          addresses_json: Json
          billing_address: Json | null
          company_number: string | null
          created_at: string
          id: string
          ops_json: Json
          recycler_partner_agreement_json: Json | null
          tax_id: string | null
          tax_registered: boolean
          updated_at: string
        }
        Insert: {
          account_id: string
          addresses_json?: Json
          billing_address?: Json | null
          company_number?: string | null
          created_at?: string
          id?: string
          ops_json?: Json
          recycler_partner_agreement_json?: Json | null
          tax_id?: string | null
          tax_registered?: boolean
          updated_at?: string
        }
        Update: {
          account_id?: string
          addresses_json?: Json
          billing_address?: Json | null
          company_number?: string | null
          created_at?: string
          id?: string
          ops_json?: Json
          recycler_partner_agreement_json?: Json | null
          tax_id?: string | null
          tax_registered?: boolean
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "account_profiles_private_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: true
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      account_profiles_public: {
        Row: {
          about: string | null
          account_id: string
          created_at: string
          display_name: string
          id: string
          logo_url: string | null
          public_fields_json: Json
          seo_slug: string | null
          updated_at: string
          website_url: string | null
        }
        Insert: {
          about?: string | null
          account_id: string
          created_at?: string
          display_name: string
          id?: string
          logo_url?: string | null
          public_fields_json?: Json
          seo_slug?: string | null
          updated_at?: string
          website_url?: string | null
        }
        Update: {
          about?: string | null
          account_id?: string
          created_at?: string
          display_name?: string
          id?: string
          logo_url?: string | null
          public_fields_json?: Json
          seo_slug?: string | null
          updated_at?: string
          website_url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "account_profiles_public_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: true
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      accounts: {
        Row: {
          account_type: Database["public"]["Enums"]["account_type"]
          created_at: string
          created_by_user_id: string | null
          id: string
          name: string
          role: Database["public"]["Enums"]["account_role"]
          sector: Database["public"]["Enums"]["account_sector"] | null
          status: Database["public"]["Enums"]["account_status"]
          stripe_connect_account_id: string | null
          stripe_connect_onboarded_at: string | null
          stripe_connect_status: string
          updated_at: string
        }
        Insert: {
          account_type: Database["public"]["Enums"]["account_type"]
          created_at?: string
          created_by_user_id?: string | null
          id?: string
          name: string
          role: Database["public"]["Enums"]["account_role"]
          sector?: Database["public"]["Enums"]["account_sector"] | null
          status?: Database["public"]["Enums"]["account_status"]
          stripe_connect_account_id?: string | null
          stripe_connect_onboarded_at?: string | null
          stripe_connect_status?: string
          updated_at?: string
        }
        Update: {
          account_type?: Database["public"]["Enums"]["account_type"]
          created_at?: string
          created_by_user_id?: string | null
          id?: string
          name?: string
          role?: Database["public"]["Enums"]["account_role"]
          sector?: Database["public"]["Enums"]["account_sector"] | null
          status?: Database["public"]["Enums"]["account_status"]
          stripe_connect_account_id?: string | null
          stripe_connect_onboarded_at?: string | null
          stripe_connect_status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "accounts_created_by_user_id_fkey"
            columns: ["created_by_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_events: {
        Row: {
          action: string
          actor_user_id: string | null
          created_at: string
          entity_id: string | null
          entity_type: string
          id: string
          payload_json: Json
        }
        Insert: {
          action: string
          actor_user_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type: string
          id?: string
          payload_json?: Json
        }
        Update: {
          action?: string
          actor_user_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string
          id?: string
          payload_json?: Json
        }
        Relationships: [
          {
            foreignKeyName: "audit_events_actor_user_id_fkey"
            columns: ["actor_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      deal_agreement_signatures: {
        Row: {
          created_at: string
          deal_id: string
          id: string
          ip_address: string | null
          role_in_deal: string
          signed_at: string
          signer_account_id: string
          signer_membership_id: string | null
          signer_name: string
          signer_user_id: string | null
          user_agent: string | null
        }
        Insert: {
          created_at?: string
          deal_id: string
          id?: string
          ip_address?: string | null
          role_in_deal: string
          signed_at?: string
          signer_account_id: string
          signer_membership_id?: string | null
          signer_name: string
          signer_user_id?: string | null
          user_agent?: string | null
        }
        Update: {
          created_at?: string
          deal_id?: string
          id?: string
          ip_address?: string | null
          role_in_deal?: string
          signed_at?: string
          signer_account_id?: string
          signer_membership_id?: string | null
          signer_name?: string
          signer_user_id?: string | null
          user_agent?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "deal_agreement_signatures_deal_id_fkey"
            columns: ["deal_id"]
            isOneToOne: false
            referencedRelation: "deals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deal_agreement_signatures_signer_account_id_fkey"
            columns: ["signer_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deal_agreement_signatures_signer_membership_id_fkey"
            columns: ["signer_membership_id"]
            isOneToOne: false
            referencedRelation: "account_memberships"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deal_agreement_signatures_signer_user_id_fkey"
            columns: ["signer_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      deal_compliance_records: {
        Row: {
          created_at: string
          deal_id: string
          evidence_document_id: string | null
          id: string
          requirement_code: string
          status: Database["public"]["Enums"]["compliance_status"]
          updated_at: string
        }
        Insert: {
          created_at?: string
          deal_id: string
          evidence_document_id?: string | null
          id?: string
          requirement_code: string
          status?: Database["public"]["Enums"]["compliance_status"]
          updated_at?: string
        }
        Update: {
          created_at?: string
          deal_id?: string
          evidence_document_id?: string | null
          id?: string
          requirement_code?: string
          status?: Database["public"]["Enums"]["compliance_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "deal_compliance_records_deal_id_fkey"
            columns: ["deal_id"]
            isOneToOne: false
            referencedRelation: "deals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deal_compliance_records_evidence_document_id_fkey"
            columns: ["evidence_document_id"]
            isOneToOne: false
            referencedRelation: "deal_documents"
            referencedColumns: ["id"]
          },
        ]
      }
      deal_documents: {
        Row: {
          corridor_code: string | null
          created_at: string
          deal_id: string
          document_type: string
          file_url: string | null
          id: string
          signed_at: string | null
          status: Database["public"]["Enums"]["document_status"]
          updated_at: string
        }
        Insert: {
          corridor_code?: string | null
          created_at?: string
          deal_id: string
          document_type: string
          file_url?: string | null
          id?: string
          signed_at?: string | null
          status?: Database["public"]["Enums"]["document_status"]
          updated_at?: string
        }
        Update: {
          corridor_code?: string | null
          created_at?: string
          deal_id?: string
          document_type?: string
          file_url?: string | null
          id?: string
          signed_at?: string | null
          status?: Database["public"]["Enums"]["document_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "deal_documents_deal_id_fkey"
            columns: ["deal_id"]
            isOneToOne: false
            referencedRelation: "deals"
            referencedColumns: ["id"]
          },
        ]
      }
      deal_logistics: {
        Row: {
          buyer_accepted_at: string | null
          carrier_json: Json
          created_at: string
          deal_id: string
          driver_company: string | null
          driver_name: string | null
          driver_phone_number: string | null
          id: string
          last_updated_by_account_id: string | null
          notes: string | null
          pickup_address_json: Json
          pickup_date: string | null
          pickup_window: string | null
          proposal_version: number
          proposed_at: string | null
          proposed_by_account_id: string | null
          rejection_reason: string | null
          status: string | null
          supplier_accepted_at: string | null
          updated_at: string
        }
        Insert: {
          buyer_accepted_at?: string | null
          carrier_json?: Json
          created_at?: string
          deal_id: string
          driver_company?: string | null
          driver_name?: string | null
          driver_phone_number?: string | null
          id?: string
          last_updated_by_account_id?: string | null
          notes?: string | null
          pickup_address_json?: Json
          pickup_date?: string | null
          pickup_window?: string | null
          proposal_version?: number
          proposed_at?: string | null
          proposed_by_account_id?: string | null
          rejection_reason?: string | null
          status?: string | null
          supplier_accepted_at?: string | null
          updated_at?: string
        }
        Update: {
          buyer_accepted_at?: string | null
          carrier_json?: Json
          created_at?: string
          deal_id?: string
          driver_company?: string | null
          driver_name?: string | null
          driver_phone_number?: string | null
          id?: string
          last_updated_by_account_id?: string | null
          notes?: string | null
          pickup_address_json?: Json
          pickup_date?: string | null
          pickup_window?: string | null
          proposal_version?: number
          proposed_at?: string | null
          proposed_by_account_id?: string | null
          rejection_reason?: string | null
          status?: string | null
          supplier_accepted_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "deal_logistics_deal_id_fkey"
            columns: ["deal_id"]
            isOneToOne: true
            referencedRelation: "deals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deal_logistics_last_updated_by_account_id_fkey"
            columns: ["last_updated_by_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deal_logistics_proposed_by_account_id_fkey"
            columns: ["proposed_by_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      deal_message_reads: {
        Row: {
          created_at: string
          deal_id: string
          id: string
          last_read_at: string
          membership_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          deal_id: string
          id?: string
          last_read_at?: string
          membership_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          deal_id?: string
          id?: string
          last_read_at?: string
          membership_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "deal_message_reads_deal_id_fkey"
            columns: ["deal_id"]
            isOneToOne: false
            referencedRelation: "deals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deal_message_reads_membership_id_fkey"
            columns: ["membership_id"]
            isOneToOne: false
            referencedRelation: "account_memberships"
            referencedColumns: ["id"]
          },
        ]
      }
      deal_messages: {
        Row: {
          attachment_url: string | null
          body: string
          created_at: string
          deal_id: string
          id: string
          is_system_seeded: boolean
          message_type: Database["public"]["Enums"]["message_type"]
          sender_membership_id: string | null
          source_offer_id: string | null
          source_offer_type:
            | Database["public"]["Enums"]["deal_source_type"]
            | null
          updated_at: string
        }
        Insert: {
          attachment_url?: string | null
          body: string
          created_at?: string
          deal_id: string
          id?: string
          is_system_seeded?: boolean
          message_type?: Database["public"]["Enums"]["message_type"]
          sender_membership_id?: string | null
          source_offer_id?: string | null
          source_offer_type?:
            | Database["public"]["Enums"]["deal_source_type"]
            | null
          updated_at?: string
        }
        Update: {
          attachment_url?: string | null
          body?: string
          created_at?: string
          deal_id?: string
          id?: string
          is_system_seeded?: boolean
          message_type?: Database["public"]["Enums"]["message_type"]
          sender_membership_id?: string | null
          source_offer_id?: string | null
          source_offer_type?:
            | Database["public"]["Enums"]["deal_source_type"]
            | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "deal_messages_deal_id_fkey"
            columns: ["deal_id"]
            isOneToOne: false
            referencedRelation: "deals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deal_messages_sender_membership_id_fkey"
            columns: ["sender_membership_id"]
            isOneToOne: false
            referencedRelation: "account_memberships"
            referencedColumns: ["id"]
          },
        ]
      }
      deal_milestones: {
        Row: {
          completed_at: string | null
          created_at: string
          deal_id: string
          due_at: string | null
          id: string
          milestone_type: Database["public"]["Enums"]["deal_workflow_step"]
          state: string
          updated_at: string
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          deal_id: string
          due_at?: string | null
          id?: string
          milestone_type: Database["public"]["Enums"]["deal_workflow_step"]
          state: string
          updated_at?: string
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          deal_id?: string
          due_at?: string | null
          id?: string
          milestone_type?: Database["public"]["Enums"]["deal_workflow_step"]
          state?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "deal_milestones_deal_id_fkey"
            columns: ["deal_id"]
            isOneToOne: false
            referencedRelation: "deals"
            referencedColumns: ["id"]
          },
        ]
      }
      deal_participants: {
        Row: {
          account_id: string
          created_at: string
          deal_id: string
          id: string
          joined_at: string
          role_in_deal: string
          updated_at: string
        }
        Insert: {
          account_id: string
          created_at?: string
          deal_id: string
          id?: string
          joined_at?: string
          role_in_deal: string
          updated_at?: string
        }
        Update: {
          account_id?: string
          created_at?: string
          deal_id?: string
          id?: string
          joined_at?: string
          role_in_deal?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "deal_participants_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deal_participants_deal_id_fkey"
            columns: ["deal_id"]
            isOneToOne: false
            referencedRelation: "deals"
            referencedColumns: ["id"]
          },
        ]
      }
      deal_payment_intents: {
        Row: {
          amount: number
          captured_at: string | null
          created_at: string
          currency: string
          deal_amount: number | null
          deal_id: string
          id: string
          payment_method_type: string | null
          payout_available_on: string | null
          payout_paid_at: string | null
          payout_status: string | null
          platform_fee_amount: number | null
          protection_fee_amount: number | null
          provider: string
          provider_ref: string | null
          status: Database["public"]["Enums"]["payment_status"]
          stripe_charge_id: string | null
          stripe_payout_id: string | null
          stripe_transfer_id: string | null
          transferred_at: string | null
          updated_at: string
        }
        Insert: {
          amount: number
          captured_at?: string | null
          created_at?: string
          currency: string
          deal_amount?: number | null
          deal_id: string
          id?: string
          payment_method_type?: string | null
          payout_available_on?: string | null
          payout_paid_at?: string | null
          payout_status?: string | null
          platform_fee_amount?: number | null
          protection_fee_amount?: number | null
          provider: string
          provider_ref?: string | null
          status?: Database["public"]["Enums"]["payment_status"]
          stripe_charge_id?: string | null
          stripe_payout_id?: string | null
          stripe_transfer_id?: string | null
          transferred_at?: string | null
          updated_at?: string
        }
        Update: {
          amount?: number
          captured_at?: string | null
          created_at?: string
          currency?: string
          deal_amount?: number | null
          deal_id?: string
          id?: string
          payment_method_type?: string | null
          payout_available_on?: string | null
          payout_paid_at?: string | null
          payout_status?: string | null
          platform_fee_amount?: number | null
          protection_fee_amount?: number | null
          provider?: string
          provider_ref?: string | null
          status?: Database["public"]["Enums"]["payment_status"]
          stripe_charge_id?: string | null
          stripe_payout_id?: string | null
          stripe_transfer_id?: string | null
          transferred_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "deal_payment_intents_deal_id_fkey"
            columns: ["deal_id"]
            isOneToOne: false
            referencedRelation: "deals"
            referencedColumns: ["id"]
          },
        ]
      }
      deals: {
        Row: {
          accepted_purchase_offer_id: string | null
          accepted_recycling_offer_id: string | null
          agreed_amount: number | null
          agreed_currency: string | null
          agreement_json: Json
          completed_at: string | null
          counterparty_account_id: string
          created_at: string
          created_by_user_id: string | null
          id: string
          listing_id: string
          quantity: number | null
          snapshot_json: Json
          source_type: Database["public"]["Enums"]["deal_source_type"]
          started_at: string
          status: Database["public"]["Enums"]["deal_status"]
          supplier_account_id: string
          updated_at: string
          workflow_step: Database["public"]["Enums"]["deal_workflow_step"]
        }
        Insert: {
          accepted_purchase_offer_id?: string | null
          accepted_recycling_offer_id?: string | null
          agreed_amount?: number | null
          agreed_currency?: string | null
          agreement_json?: Json
          completed_at?: string | null
          counterparty_account_id: string
          created_at?: string
          created_by_user_id?: string | null
          id?: string
          listing_id: string
          quantity?: number | null
          snapshot_json?: Json
          source_type: Database["public"]["Enums"]["deal_source_type"]
          started_at?: string
          status?: Database["public"]["Enums"]["deal_status"]
          supplier_account_id: string
          updated_at?: string
          workflow_step?: Database["public"]["Enums"]["deal_workflow_step"]
        }
        Update: {
          accepted_purchase_offer_id?: string | null
          accepted_recycling_offer_id?: string | null
          agreed_amount?: number | null
          agreed_currency?: string | null
          agreement_json?: Json
          completed_at?: string | null
          counterparty_account_id?: string
          created_at?: string
          created_by_user_id?: string | null
          id?: string
          listing_id?: string
          quantity?: number | null
          snapshot_json?: Json
          source_type?: Database["public"]["Enums"]["deal_source_type"]
          started_at?: string
          status?: Database["public"]["Enums"]["deal_status"]
          supplier_account_id?: string
          updated_at?: string
          workflow_step?: Database["public"]["Enums"]["deal_workflow_step"]
        }
        Relationships: [
          {
            foreignKeyName: "deals_accepted_purchase_offer_id_fkey"
            columns: ["accepted_purchase_offer_id"]
            isOneToOne: false
            referencedRelation: "purchase_offers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deals_accepted_recycling_offer_id_fkey"
            columns: ["accepted_recycling_offer_id"]
            isOneToOne: false
            referencedRelation: "recycling_offers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deals_counterparty_account_id_fkey"
            columns: ["counterparty_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deals_created_by_user_id_fkey"
            columns: ["created_by_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deals_listing_id_fkey"
            columns: ["listing_id"]
            isOneToOne: false
            referencedRelation: "listings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deals_listing_id_fkey"
            columns: ["listing_id"]
            isOneToOne: false
            referencedRelation: "listings_marketplace_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deals_supplier_account_id_fkey"
            columns: ["supplier_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      email_suppressions: {
        Row: {
          email: string
          id: string
          metadata: Json | null
          reason: string
          suppressed_at: string
        }
        Insert: {
          email: string
          id?: string
          metadata?: Json | null
          reason: string
          suppressed_at?: string
        }
        Update: {
          email?: string
          id?: string
          metadata?: Json | null
          reason?: string
          suppressed_at?: string
        }
        Relationships: []
      }
      listing_media: {
        Row: {
          created_at: string
          file_url: string
          id: string
          listing_id: string
          media_type: string
          sort_order: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          file_url: string
          id?: string
          listing_id: string
          media_type: string
          sort_order?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          file_url?: string
          id?: string
          listing_id?: string
          media_type?: string
          sort_order?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "listing_media_listing_id_fkey"
            columns: ["listing_id"]
            isOneToOne: false
            referencedRelation: "listings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "listing_media_listing_id_fkey"
            columns: ["listing_id"]
            isOneToOne: false
            referencedRelation: "listings_marketplace_v"
            referencedColumns: ["id"]
          },
        ]
      }
      listing_specs: {
        Row: {
          category: Database["public"]["Enums"]["listing_category"] | null
          cell_chemistry_detail: string | null
          chemistry: string | null
          condition_json: Json
          created_at: string
          format: string | null
          id: string
          listing_id: string
          location_address: Json | null
          location_city: string | null
          location_country: string | null
          location_region: string | null
          manufacturer: string | null
          metadata_json: Json
          minimum_order_quantity: number | null
          model: string | null
          original_application: string | null
          pack_kwh: number | null
          pack_weight_kg: number | null
          quantity: number | null
          soh: number | null
          updated_at: string
          voltage_nominal: number | null
          year_manufacture: number | null
        }
        Insert: {
          category?: Database["public"]["Enums"]["listing_category"] | null
          cell_chemistry_detail?: string | null
          chemistry?: string | null
          condition_json?: Json
          created_at?: string
          format?: string | null
          id?: string
          listing_id: string
          location_address?: Json | null
          location_city?: string | null
          location_country?: string | null
          location_region?: string | null
          manufacturer?: string | null
          metadata_json?: Json
          minimum_order_quantity?: number | null
          model?: string | null
          original_application?: string | null
          pack_kwh?: number | null
          pack_weight_kg?: number | null
          quantity?: number | null
          soh?: number | null
          updated_at?: string
          voltage_nominal?: number | null
          year_manufacture?: number | null
        }
        Update: {
          category?: Database["public"]["Enums"]["listing_category"] | null
          cell_chemistry_detail?: string | null
          chemistry?: string | null
          condition_json?: Json
          created_at?: string
          format?: string | null
          id?: string
          listing_id?: string
          location_address?: Json | null
          location_city?: string | null
          location_country?: string | null
          location_region?: string | null
          manufacturer?: string | null
          metadata_json?: Json
          minimum_order_quantity?: number | null
          model?: string | null
          original_application?: string | null
          pack_kwh?: number | null
          pack_weight_kg?: number | null
          quantity?: number | null
          soh?: number | null
          updated_at?: string
          voltage_nominal?: number | null
          year_manufacture?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "listing_specs_listing_id_fkey"
            columns: ["listing_id"]
            isOneToOne: true
            referencedRelation: "listings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "listing_specs_listing_id_fkey"
            columns: ["listing_id"]
            isOneToOne: true
            referencedRelation: "listings_marketplace_v"
            referencedColumns: ["id"]
          },
        ]
      }
      listing_views: {
        Row: {
          country: string | null
          device_type: string
          id: string
          ip_address: unknown
          listing_id: string
          referer: string | null
          viewed_at: string
          viewer_user_id: string | null
        }
        Insert: {
          country?: string | null
          device_type?: string
          id?: string
          ip_address: unknown
          listing_id: string
          referer?: string | null
          viewed_at?: string
          viewer_user_id?: string | null
        }
        Update: {
          country?: string | null
          device_type?: string
          id?: string
          ip_address?: unknown
          listing_id?: string
          referer?: string | null
          viewed_at?: string
          viewer_user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "listing_views_listing_id_fkey"
            columns: ["listing_id"]
            isOneToOne: false
            referencedRelation: "listings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "listing_views_listing_id_fkey"
            columns: ["listing_id"]
            isOneToOne: false
            referencedRelation: "listings_marketplace_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "listing_views_viewer_user_id_fkey"
            columns: ["viewer_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      listings: {
        Row: {
          allow_agreement_changes: boolean
          allow_bids: boolean
          currency: string | null
          buy_now_enabled: boolean
          buy_now_price: number | null
          channel_mode: Database["public"]["Enums"]["listing_channel_mode"]
          created_at: string
          created_by_user_id: string | null
          description: string | null
          id: string
          listing_status: Database["public"]["Enums"]["listing_status"]
          reference: string | null
          seo_slug: string | null
          supplier_account_id: string
          title: string
          updated_at: string
          visibility: Database["public"]["Enums"]["listing_visibility"]
        }
        Insert: {
          allow_agreement_changes?: boolean
          allow_bids?: boolean
          currency?: string | null
          buy_now_enabled?: boolean
          buy_now_price?: number | null
          channel_mode: Database["public"]["Enums"]["listing_channel_mode"]
          created_at?: string
          created_by_user_id?: string | null
          description?: string | null
          id?: string
          listing_status?: Database["public"]["Enums"]["listing_status"]
          reference?: string | null
          seo_slug?: string | null
          supplier_account_id: string
          title: string
          updated_at?: string
          visibility?: Database["public"]["Enums"]["listing_visibility"]
        }
        Update: {
          allow_agreement_changes?: boolean
          allow_bids?: boolean
          currency?: string | null
          buy_now_enabled?: boolean
          buy_now_price?: number | null
          channel_mode?: Database["public"]["Enums"]["listing_channel_mode"]
          created_at?: string
          created_by_user_id?: string | null
          description?: string | null
          id?: string
          listing_status?: Database["public"]["Enums"]["listing_status"]
          reference?: string | null
          seo_slug?: string | null
          supplier_account_id?: string
          title?: string
          updated_at?: string
          visibility?: Database["public"]["Enums"]["listing_visibility"]
        }
        Relationships: [
          {
            foreignKeyName: "listings_created_by_user_id_fkey"
            columns: ["created_by_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "listings_supplier_account_id_fkey"
            columns: ["supplier_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      notification_deliveries: {
        Row: {
          attempted_at: string | null
          created_at: string
          deal_id: string | null
          error_code: string | null
          error_message: string | null
          event_type: string
          id: string
          payload_json: Json
          provider: string
          provider_message_id: string | null
          recipient_email: string
          recipient_user_id: string
          sender_user_id: string | null
          sent_at: string | null
          status: string
        }
        Insert: {
          attempted_at?: string | null
          created_at?: string
          deal_id?: string | null
          error_code?: string | null
          error_message?: string | null
          event_type: string
          id?: string
          payload_json?: Json
          provider?: string
          provider_message_id?: string | null
          recipient_email: string
          recipient_user_id: string
          sender_user_id?: string | null
          sent_at?: string | null
          status: string
        }
        Update: {
          attempted_at?: string | null
          created_at?: string
          deal_id?: string | null
          error_code?: string | null
          error_message?: string | null
          event_type?: string
          id?: string
          payload_json?: Json
          provider?: string
          provider_message_id?: string | null
          recipient_email?: string
          recipient_user_id?: string
          sender_user_id?: string | null
          sent_at?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "notification_deliveries_deal_id_fkey"
            columns: ["deal_id"]
            isOneToOne: false
            referencedRelation: "deals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notification_deliveries_recipient_user_id_fkey"
            columns: ["recipient_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notification_deliveries_sender_user_id_fkey"
            columns: ["sender_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      notification_preferences: {
        Row: {
          created_at: string
          enabled: boolean
          event_type: string
          id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          enabled?: boolean
          event_type: string
          id?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          enabled?: boolean
          event_type?: string
          id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "notification_preferences_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      purchase_offers: {
        Row: {
          amount: number | null
          buyer_account_id: string
          counter_amount: number | null
          created_at: string
          created_by_user_id: string | null
          currency: string | null
          id: string
          initial_message: string | null
          listing_id: string
          offer_kind: Database["public"]["Enums"]["offer_kind"]
          quantity_requested: number | null
          status: Database["public"]["Enums"]["offer_status"]
          submitted_at: string
          terms_json: Json
          updated_at: string
        }
        Insert: {
          amount?: number | null
          buyer_account_id: string
          counter_amount?: number | null
          created_at?: string
          created_by_user_id?: string | null
          currency?: string | null
          id?: string
          initial_message?: string | null
          listing_id: string
          offer_kind?: Database["public"]["Enums"]["offer_kind"]
          quantity_requested?: number | null
          status?: Database["public"]["Enums"]["offer_status"]
          submitted_at?: string
          terms_json?: Json
          updated_at?: string
        }
        Update: {
          amount?: number | null
          buyer_account_id?: string
          counter_amount?: number | null
          created_at?: string
          created_by_user_id?: string | null
          currency?: string | null
          id?: string
          initial_message?: string | null
          listing_id?: string
          offer_kind?: Database["public"]["Enums"]["offer_kind"]
          quantity_requested?: number | null
          status?: Database["public"]["Enums"]["offer_status"]
          submitted_at?: string
          terms_json?: Json
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "purchase_offers_buyer_account_id_fkey"
            columns: ["buyer_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_offers_created_by_user_id_fkey"
            columns: ["created_by_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_offers_listing_id_fkey"
            columns: ["listing_id"]
            isOneToOne: false
            referencedRelation: "listings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_offers_listing_id_fkey"
            columns: ["listing_id"]
            isOneToOne: false
            referencedRelation: "listings_marketplace_v"
            referencedColumns: ["id"]
          },
        ]
      }
       recycler_opportunity_links: {
        Row: {
          created_at: string
          expires_at: string
          id: string
          link_type: Database["public"]["Enums"]["opportunity_link_type"]
          listing_id: string
          rebattery_notes: string | null
          recycler_account_id: string
          state: Database["public"]["Enums"]["opportunity_link_state"]
          updated_at: string
        }
        Insert: {
          created_at?: string
          expires_at: string
          id?: string
          link_type: Database["public"]["Enums"]["opportunity_link_type"]
          listing_id: string
          rebattery_notes?: string | null
          recycler_account_id: string
          state?: Database["public"]["Enums"]["opportunity_link_state"]
          updated_at?: string
        }
        Update: {
          created_at?: string
          expires_at?: string
          id?: string
          link_type?: Database["public"]["Enums"]["opportunity_link_type"]
          listing_id?: string
          rebattery_notes?: string | null
          recycler_account_id?: string
          state?: Database["public"]["Enums"]["opportunity_link_state"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "recycler_opportunity_links_listing_id_fkey"
            columns: ["listing_id"]
            isOneToOne: false
            referencedRelation: "listings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "recycler_opportunity_links_listing_id_fkey"
            columns: ["listing_id"]
            isOneToOne: false
            referencedRelation: "listings_marketplace_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "recycler_opportunity_links_recycler_account_id_fkey"
            columns: ["recycler_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      recycling_offers: {
        Row: {
          amount: number | null
          counter_amount: number | null
          created_at: string
          created_by_user_id: string | null
          currency: string | null
          id: string
          initial_message: string | null
          listing_id: string
          offer_kind: Database["public"]["Enums"]["offer_kind"]
          recycler_account_id: string
          status: Database["public"]["Enums"]["offer_status"]
          submitted_at: string
          terms_json: Json
          updated_at: string
        }
        Insert: {
          amount?: number | null
          counter_amount?: number | null
          created_at?: string
          created_by_user_id?: string | null
          currency?: string | null
          id?: string
          initial_message?: string | null
          listing_id: string
          offer_kind?: Database["public"]["Enums"]["offer_kind"]
          recycler_account_id: string
          status?: Database["public"]["Enums"]["offer_status"]
          submitted_at?: string
          terms_json?: Json
          updated_at?: string
        }
        Update: {
          amount?: number | null
          counter_amount?: number | null
          created_at?: string
          created_by_user_id?: string | null
          currency?: string | null
          id?: string
          initial_message?: string | null
          listing_id?: string
          offer_kind?: Database["public"]["Enums"]["offer_kind"]
          recycler_account_id?: string
          status?: Database["public"]["Enums"]["offer_status"]
          submitted_at?: string
          terms_json?: Json
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "recycling_offers_created_by_user_id_fkey"
            columns: ["created_by_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "recycling_offers_listing_id_fkey"
            columns: ["listing_id"]
            isOneToOne: false
            referencedRelation: "listings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "recycling_offers_listing_id_fkey"
            columns: ["listing_id"]
            isOneToOne: false
            referencedRelation: "listings_marketplace_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "recycling_offers_recycler_account_id_fkey"
            columns: ["recycler_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      stripe_webhook_events: {
        Row: {
          created_at: string
          event_id: string
          event_type: string
          id: string
          object_id: string | null
          payload_json: Json
          processed_at: string | null
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          event_id: string
          event_type: string
          id?: string
          object_id?: string | null
          payload_json?: Json
          processed_at?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          event_id?: string
          event_type?: string
          id?: string
          object_id?: string | null
          payload_json?: Json
          processed_at?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      users: {
        Row: {
          auth_user_id: string | null
          avatar_url: string | null
          created_at: string
          email: string
          full_name: string | null
          id: string
          other: Json
          phone_number: string | null
          position: string | null
          status: Database["public"]["Enums"]["account_status"] | null
          updated_at: string
        }
        Insert: {
          auth_user_id?: string | null
          avatar_url?: string | null
          created_at?: string
          email: string
          full_name?: string | null
          id?: string
          other?: Json
          phone_number?: string | null
          position?: string | null
          status?: Database["public"]["Enums"]["account_status"] | null
          updated_at?: string
        }
        Update: {
          auth_user_id?: string | null
          avatar_url?: string | null
          created_at?: string
          email?: string
          full_name?: string | null
          id?: string
          other?: Json
          phone_number?: string | null
          position?: string | null
          status?: Database["public"]["Enums"]["account_status"] | null
          updated_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      deal_participant_enriched: {
        Row: {
          account_id: string | null
          account_name: string | null
          account_role: Database["public"]["Enums"]["account_role"] | null
          avatar_url: string | null
          deal_id: string | null
          id: string | null
          role_in_deal: string | null
          user_full_name: string | null
        }
        Relationships: [
          {
            foreignKeyName: "deal_participants_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deal_participants_deal_id_fkey"
            columns: ["deal_id"]
            isOneToOne: false
            referencedRelation: "deals"
            referencedColumns: ["id"]
          },
        ]
      }
      listings_marketplace_v: {
        Row: {
          allow_bids: boolean | null
          currency: string | null
          buy_now_enabled: boolean | null
          buy_now_price: number | null
          category: Database["public"]["Enums"]["listing_category"] | null
          cell_chemistry_detail: string | null
          channel_mode:
            | Database["public"]["Enums"]["listing_channel_mode"]
            | null
          chemistry: string | null
          condition_json: Json | null
          created_at: string | null
          description: string | null
          format: string | null
          id: string | null
          listing_status: Database["public"]["Enums"]["listing_status"] | null
          location_city: string | null
          location_country: string | null
          location_region: string | null
          original_application: string | null
          pack_kwh: number | null
          pack_weight_kg: number | null
          quantity: number | null
          seo_slug: string | null
          soh: number | null
          supplier_account_id: string | null
          supplier_display_name: string | null
          thumbnail_url: string | null
          title: string | null
          updated_at: string | null
          visibility: Database["public"]["Enums"]["listing_visibility"] | null
          voltage_nominal: number | null
          year_manufacture: number | null
        }
        Relationships: [
          {
            foreignKeyName: "listings_supplier_account_id_fkey"
            columns: ["supplier_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      buy_now_decrement_stock: {
        Args: { p_listing_id: string; p_quantity: number }
        Returns: undefined
      }
      get_listing_activity_counts: {
        Args: { listing_ids: string[] }
        Returns: {
          listing_id: string
          enquiry_count: number
          deal_count: number
        }[]
      }
    }
    Enums: {
      account_role: "supplier" | "buyer" | "recycler"
      account_sector:
        | "electric_vehicles_oem"
        | "energy_storage_oem"
        | "portable_battery_oem"
        | "industrial_product_oem"
        | "robotics_oem"
        | "cell_manufacturer"
        | "battery_assembler"
        | "micromobility_oem"
        | "marine_oem"
        | "battery_recycler"
        | "general_recycler"
        | "battery_repurposer_second_life"
        | "trader"
        | "government"
        | "other"
      account_status:
        | "pending"
        | "active"
        | "suspended"
        | "archived"
        | "waitlist"
        | "approved"
      account_type: "individual" | "organization"
      compliance_status:
        | "required"
        | "pending_review"
        | "accepted"
        | "rejected"
        | "locked"
      deal_source_type: "purchase_offer" | "recycling_offer" | "buy_now"
      deal_status: "open" | "completed" | "cancelled" | "disputed"
      deal_workflow_step:
        | "accepted"
        | "terms_agreed"
        | "payment_pending"
        | "payment_confirmed"
        | "collection_scheduled"
        | "completed"
      document_status:
        | "required"
        | "uploaded"
        | "reviewed"
        | "accepted"
        | "locked"
        | "rejected"
      listing_category:
        | "ev"
        | "e_mobility"
        | "industrial"
        | "energy_storage"
        | "marine"
        | "other"
      listing_channel_mode: "sale" | "recycling"
      listing_status: "draft" | "published" | "withdrawn" | "completed"
      listing_visibility: "public" | "buyer_network"
      membership_role: "owner" | "admin" | "member"
      message_type: "user" | "offer_intro" | "system"
      offer_kind:
        | "bid"
        | "agreement_change"
        | "recycling_enquiry"
        | "buy_now_checkout"
      offer_status:
        | "submitted"
        | "under_review"
        | "countered"
        | "accepted"
        | "rejected"
        | "withdrawn"
        | "expired"
      opportunity_link_state: "active" | "paused" | "archived" | "claimed"
      opportunity_link_type: "suggested" | "assigned" | "invited"
      payment_status:
        | "requires_action"
        | "processing"
        | "captured"
        | "failed"
        | "refunded"
        | "cancelled"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      account_role: ["supplier", "buyer", "recycler"],
      account_sector: [
        "electric_vehicles_oem",
        "energy_storage_oem",
        "portable_battery_oem",
        "industrial_product_oem",
        "robotics_oem",
        "cell_manufacturer",
        "battery_assembler",
        "micromobility_oem",
        "marine_oem",
        "battery_recycler",
        "general_recycler",
        "battery_repurposer_second_life",
        "trader",
        "government",
        "other",
      ],
      account_status: [
        "pending",
        "active",
        "suspended",
        "archived",
        "waitlist",
        "approved",
      ],
      account_type: ["individual", "organization"],
      compliance_status: [
        "required",
        "pending_review",
        "accepted",
        "rejected",
        "locked",
      ],
      deal_source_type: ["purchase_offer", "recycling_offer", "buy_now"],
      deal_status: ["open", "completed", "cancelled", "disputed"],
      deal_workflow_step: [
        "accepted",
        "terms_agreed",
        "payment_pending",
        "payment_confirmed",
        "collection_scheduled",
        "completed",
      ],
      document_status: [
        "required",
        "uploaded",
        "reviewed",
        "accepted",
        "locked",
        "rejected",
      ],
      listing_category: [
        "ev",
        "e_mobility",
        "industrial",
        "energy_storage",
        "marine",
        "other",
      ],
      listing_channel_mode: ["sale", "recycling"],
      listing_status: ["draft", "published", "withdrawn", "completed"],
      listing_visibility: ["public", "buyer_network"],
      membership_role: ["owner", "admin", "member"],
      message_type: ["user", "offer_intro", "system"],
      offer_kind: [
        "bid",
        "agreement_change",
        "recycling_enquiry",
        "buy_now_checkout",
      ],
      offer_status: [
        "submitted",
        "under_review",
        "countered",
        "accepted",
        "rejected",
        "withdrawn",
        "expired",
      ],
      opportunity_link_state: ["active", "paused", "archived", "claimed"],
      opportunity_link_type: ["suggested", "assigned", "invited"],
      payment_status: [
        "requires_action",
        "processing",
        "captured",
        "failed",
        "refunded",
        "cancelled",
      ],
    },
  },
} as const
