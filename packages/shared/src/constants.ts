export const EMBEDDING_DIMENSIONS = 768;
// nomic-embed-text context is 2048 tokens; chunks must fit within that
export const CHUNK_THRESHOLD_TOKENS = 1500;
export const CHUNK_SIZE_TOKENS = 500;
export const CHUNK_OVERLAP_TOKENS = 50;
export const DEFAULT_POLL_INTERVAL_MS = 5000;
export const DEFAULT_BATCH_SIZE = 5;
export const DEFAULT_MAX_RETRIES = 3;
export const DEFAULT_MCP_PORT = 3000;
export const SEARCH_DOCUMENT_PREFIX = 'search_document: ';
export const SEARCH_QUERY_PREFIX = 'search_query: ';

// Approval thresholds
export const DEFAULT_APPROVAL_THRESHOLD = 0.8;
export const APPROVAL_THRESHOLDS: Record<string, number | 'always'> = {
  entity_link: 0.8,
  entity_enrichment: 'always',
  entity_merge: 'always',
};

// LinkedIn enricher
export const LINKEDIN_ENRICHMENT_INTERVAL_MS = 60_000;
export const LINKEDIN_ENRICHMENT_BATCH_SIZE = 5;
export const SERPAPI_DAILY_LIMIT = 33; // ~1000/month on Starter plan

// Chat RAG settings
export const CHAT_CONTEXT_SEARCH_LIMIT = 5;
export const CHAT_CONTEXT_SEARCH_THRESHOLD = 0.3;
export const CHAT_MAX_HISTORY_MESSAGES = 20;

// Correction examples
export const CORRECTION_CATEGORIES = ['linkedin_search', 'entity_extraction', 'entity_link', 'profile_generation'] as const;
export const MAX_PROMPT_INJECTION_EXAMPLES = 3;

// Entity staleness thresholds
export const ENTITY_STALE_MENTIONS = 10;
export const ENTITY_STALE_DAYS = 7;
export const PROFILE_REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
export const PROFILE_REFRESH_BATCH_SIZE = 5;
