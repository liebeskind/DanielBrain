export interface Thought {
  id: string;
  content: string;
  embedding?: number[];

  // Extracted metadata
  thought_type?: string | null;
  people?: string[];
  topics?: string[];
  action_items?: string[];
  dates_mentioned?: Date[];
  sentiment?: string | null;
  summary?: string | null;

  // Extended extraction fields
  key_decisions?: string[];
  key_insights?: string[];
  themes?: string[];
  department?: string | null;
  confidentiality?: string | null;
  meeting_participants?: string[];
  action_items_structured?: Array<{ action: string; assignee: string | null; deadline: string | null; status: 'open' | 'done' | null }> | null;

  // Chunking support
  parent_id?: string | null;
  chunk_index?: number | null;

  // Source tracking
  source: string;
  source_id?: string | null;
  source_meta?: Record<string, unknown> | null;

  // Permissions
  visibility: string[];

  created_at: Date;
  processed_at?: Date | null;
  updated_at: Date;
}

export interface QueueItem {
  id: string;
  content: string;
  source: string;
  source_id?: string | null;
  source_meta?: Record<string, unknown> | null;
  originated_at?: Date | null;
  content_hash?: string | null;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  error?: string | null;
  attempts: number;
  thought_id?: string | null;
  created_at: Date;
  processed_at?: Date | null;
}

// --- Source Envelope types (ride inside source_meta) ---

export interface ParticipantIdentity {
  name: string;
  email?: string | null;
  platform_id?: string | null;
  role?: 'author' | 'participant' | 'recorder' | 'assignee';
}

export interface StructuredData {
  summary?: string | null;
  action_items?: Array<{
    description: string;
    assignee_name?: string | null;
    assignee_email?: string | null;
    completed?: boolean;
  }>;
  participants?: ParticipantIdentity[];
  companies?: Array<{ name: string; record_url?: string }>;
}

export type ChannelType = 'public' | 'private' | 'dm' | 'group_dm' | 'meeting' | 'manual';

export interface AccessKey {
  id: string;
  name: string;
  key_hash: string;
  scopes: string[];
  active: boolean;
  created_at: Date;
  last_used?: Date | null;
  expires_at?: Date | null;
}

export interface ThoughtMetadata {
  thought_type: string | null;
  people: string[];
  topics: string[];
  action_items: string[];
  dates_mentioned: string[];
  sentiment: string | null;
  summary: string | null;
  companies: string[];
  products: string[];
  projects: string[];
  department: string | null;
  confidentiality: string | null;
  themes: string[];
  key_decisions: string[];
  key_insights: string[];
  meeting_participants: string[];
  action_items_structured: Array<{
    action: string;
    assignee: string | null;
    deadline: string | null;
    status: 'open' | 'done' | null;
  }>;
}

export type EntityType = 'person' | 'company' | 'topic' | 'product' | 'project' | 'place';
export type EntityRelationshipType = 'mentions' | 'about' | 'from' | 'assigned_to' | 'created_by';

export interface Entity {
  id: string;
  name: string;
  entity_type: EntityType;
  aliases: string[];
  canonical_name: string;
  profile_summary: string | null;
  embedding?: number[];
  metadata: Record<string, unknown>;
  mention_count: number;
  visibility: string[];
  first_seen_at: Date;
  last_seen_at: Date;
  created_at: Date;
  updated_at: Date;
}

export interface ThoughtEntity {
  thought_id: string;
  entity_id: string;
  relationship: EntityRelationshipType;
  confidence: number;
  created_at: Date;
}

export type ProposalStatus = 'pending' | 'approved' | 'rejected' | 'needs_changes' | 'applied' | 'failed';

export interface Proposal {
  id: string;
  proposal_type: string;
  status: ProposalStatus;
  entity_id: string | null;
  title: string;
  description: string | null;
  proposed_data: Record<string, unknown>;
  current_data: Record<string, unknown> | null;
  auto_applied: boolean;
  reviewer_notes: string | null;
  source: string;
  applied_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export type CorrectionCategory = 'linkedin_search' | 'entity_extraction' | 'entity_link' | 'profile_generation';

export interface CorrectionExample {
  id: string;
  category: CorrectionCategory;
  input_context: Record<string, unknown>;
  actual_output: Record<string, unknown> | null;
  expected_output: Record<string, unknown>;
  explanation: string | null;
  entity_id: string | null;
  proposal_id: string | null;
  tags: string[];
  created_at: Date;
  updated_at: Date;
}

export interface EntityRelationship {
  id: string;
  source_id: string;
  target_id: string;
  relationship: string;
  description: string | null;
  weight: number;
  metadata: Record<string, unknown>;
  visibility: string[];
  valid_at: Date | null;
  invalid_at: Date | null;
  source_thought_ids: string[];
  is_explicit: boolean;
  first_seen_at: Date;
  last_seen_at: Date;
  created_at: Date;
  updated_at: Date;
}

export interface Conversation {
  id: string;
  title: string | null;
  project_id: string | null;
  is_deleted: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface ChatMessage {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant';
  content: string;
  context_data: { sources: any[]; entities: any[] } | null;
  created_at: Date;
}

export interface ChatProject {
  id: string;
  name: string;
  is_deleted: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface Community {
  id: string;
  level: number;
  title: string | null;
  summary: string | null;
  full_report: string | null;
  embedding: number[] | null;
  member_count: number;
  created_at: Date;
  updated_at: Date;
}

export interface EntityCommunity {
  entity_id: string;
  community_id: string;
  level: number;
}

export interface SearchResult {
  id: string;
  content: string;
  thought_type: string | null;
  people: string[];
  topics: string[];
  action_items: string[];
  dates_mentioned: Date[];
  summary: string | null;
  similarity: number;
  parent_id: string | null;
  chunk_index: number | null;
  source: string;
  created_at: Date;
  key_decisions?: string[];
  key_insights?: string[];
}
