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
  status: 'pending' | 'processing' | 'completed' | 'failed';
  error?: string | null;
  attempts: number;
  thought_id?: string | null;
  created_at: Date;
  processed_at?: Date | null;
}

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
}
