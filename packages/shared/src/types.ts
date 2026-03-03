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
