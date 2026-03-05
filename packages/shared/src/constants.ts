export const EMBEDDING_DIMENSIONS = 768;
export const CHUNK_THRESHOLD_TOKENS = 6000;
export const CHUNK_SIZE_TOKENS = 2000;
export const CHUNK_OVERLAP_TOKENS = 200;
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

// Entity staleness thresholds
export const ENTITY_STALE_MENTIONS = 10;
export const ENTITY_STALE_DAYS = 7;
export const PROFILE_REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
export const PROFILE_REFRESH_BATCH_SIZE = 5;
