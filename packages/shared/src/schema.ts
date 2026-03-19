import { z } from 'zod';

// ISO date pattern: YYYY-MM-DD
const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;

// Coerce LLM sentiment output to valid enum or null
const sentimentValues = ['positive', 'negative', 'neutral', 'mixed'] as const;
const resilientSentiment = z
  .unknown()
  .transform((val) => {
    if (val == null || val === 'null' || val === '') return null;
    const lower = String(val).toLowerCase().trim();
    if (sentimentValues.includes(lower as typeof sentimentValues[number])) {
      return lower as typeof sentimentValues[number];
    }
    return null; // Unknown sentiment → null rather than crash
  });

// Filter dates_mentioned to only valid ISO dates (LLM often returns junk like "no dates mentioned")
const resilientDates = z
  .array(z.unknown())
  .default([])
  .transform((arr) =>
    arr
      .map((v) => String(v).trim())
      .filter((s) => isoDatePattern.test(s) && !isNaN(Date.parse(s)))
  );

export const metadataSchema = z.object({
  thought_type: z.string().nullable().default(null),
  people: z.array(z.string()).default([]),
  topics: z.array(z.string()).default([]),
  action_items: z.array(z.string()).default([]),
  dates_mentioned: resilientDates,
  sentiment: resilientSentiment,
  summary: z.string().nullable().default(null),
  companies: z.array(z.string()).default([]),
  products: z.array(z.string()).default([]),
  projects: z.array(z.string()).default([]),
  department: z.string().nullable().default(null),
  confidentiality: z.string().nullable().default(null),
  themes: z.array(z.string()).default([]),
  key_decisions: z.array(z.string()).default([]),
  key_insights: z.array(z.string()).default([]),
  meeting_participants: z.array(z.string()).default([]),
  action_items_structured: z.array(z.object({
    action: z.string(),
    assignee: z.string().nullable().default(null),
    deadline: z.string().nullable().default(null),
    status: z.enum(['open', 'done']).nullable().default(null),
  })).default([]),
});

export const semanticSearchInputSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(100).default(10),
  threshold: z.number().min(0).max(1).default(0.5),
  thought_type: z.string().optional(),
  person: z.string().optional(),
  topic: z.string().optional(),
  days_back: z.number().int().min(1).optional(),
  source: z.string().optional(),
  sources: z.array(z.string()).optional(),
});

export const listRecentInputSchema = z.object({
  days: z.number().int().min(1).default(7),
  limit: z.number().int().min(1).max(100).default(20),
  thought_type: z.string().optional(),
  source: z.string().optional(),
});

export const statsInputSchema = z.object({
  period: z.enum(['week', 'month', 'quarter', 'year', 'all']).default('month'),
});

export const saveThoughtInputSchema = z.object({
  content: z.string().min(1),
  source: z.string().default('mcp'),
});

// --- Entity tool schemas ---

const entityTypeEnum = z.enum(['person', 'company', 'topic', 'product', 'project', 'place']);

export const getEntityInputSchema = z.object({
  entity_id: z.string().uuid().optional(),
  name: z.string().min(1).optional(),
  entity_type: entityTypeEnum.optional(),
}).refine(
  (data) => data.entity_id || data.name,
  { message: 'Either entity_id or name must be provided' }
);

export const listEntitiesInputSchema = z.object({
  entity_type: entityTypeEnum.optional(),
  query: z.string().optional(),
  sort_by: z.enum(['mention_count', 'last_seen_at', 'name']).default('mention_count'),
  limit: z.number().int().min(1).max(100).default(20),
});

export const getContextInputSchema = z.object({
  entities: z.array(z.string().min(1)).min(1).max(5),
  days_back: z.number().int().min(1).default(30),
  include_action_items: z.boolean().default(true),
  max_thoughts: z.number().int().min(1).max(50).default(20),
});

export const getTimelineInputSchema = z.object({
  entity_id: z.string().uuid().optional(),
  entity_name: z.string().min(1).optional(),
  days_back: z.number().int().min(1).default(30),
  limit: z.number().int().min(1).max(100).default(50),
  sources: z.array(z.string()).optional(),
}).refine(
  (data) => data.entity_id || data.entity_name,
  { message: 'Either entity_id or entity_name must be provided' }
);

// --- Proposal schemas ---

const proposalStatusEnum = z.enum(['pending', 'approved', 'rejected', 'needs_changes', 'applied', 'failed']);

export const listProposalsInputSchema = z.object({
  status: proposalStatusEnum.optional(),
  proposal_type: z.string().optional(),
  limit: z.number().int().min(0).max(100).default(20),
  offset: z.number().int().min(0).default(0),
});

export const reviewProposalInputSchema = z.object({
  action: z.enum(['approve', 'reject', 'needs_changes']),
  reviewer_notes: z.string().optional(),
});

// --- Correction example schemas ---

const correctionCategoryEnum = z.enum(['linkedin_search', 'entity_extraction', 'entity_link', 'profile_generation']);

export const createCorrectionExampleSchema = z.object({
  category: correctionCategoryEnum,
  input_context: z.record(z.unknown()),
  actual_output: z.record(z.unknown()).nullable().optional(),
  expected_output: z.record(z.unknown()),
  explanation: z.string().nullable().optional(),
  entity_id: z.string().uuid().nullable().optional(),
  proposal_id: z.string().uuid().nullable().optional(),
  tags: z.array(z.string()).default([]),
});

export const listCorrectionExamplesSchema = z.object({
  category: correctionCategoryEnum.optional(),
  entity_id: z.string().uuid().optional(),
  tags: z.array(z.string()).optional(),
  limit: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().min(0).default(0),
});

// --- New MCP tool schemas ---

export const queryRelationshipsInputSchema = z.object({
  entity_name: z.string().min(1).optional(),
  entity_id: z.string().uuid().optional(),
  min_weight: z.number().int().min(1).default(1),
  limit: z.number().int().min(1).max(100).default(20),
}).refine(
  (data) => data.entity_id || data.entity_name,
  { message: 'Either entity_id or entity_name must be provided' }
);

export const updateThoughtInputSchema = z.object({
  thought_id: z.string().uuid(),
  summary: z.string().optional(),
  action_items: z.array(z.string()).optional(),
  people: z.array(z.string()).optional(),
  topics: z.array(z.string()).optional(),
  thought_type: z.string().optional(),
  sentiment: z.string().optional(),
});

export const proposeRelationshipInputSchema = z.object({
  source_entity: z.string().min(1),
  target_entity: z.string().min(1),
  description: z.string().min(1),
  relationship_type: z.string().default('related_to'),
});

// --- Agent interface schemas ---

export const updateEntityInputSchema = z.object({
  entity_id: z.string().uuid().optional(),
  name: z.string().min(1).optional(),
  new_name: z.string().min(1).optional(),
  add_aliases: z.array(z.string()).optional(),
  remove_aliases: z.array(z.string()).optional(),
  metadata: z.record(z.unknown()).optional(),
  entity_type: entityTypeEnum.optional(),
});

export const proposeMergeInputSchema = z.object({
  winner: z.string().min(1),
  loser: z.string().min(1),
  reason: z.string().optional(),
});

export const askInputSchema = z.object({
  query: z.string().min(1),
  days_back: z.number().int().min(1).optional(),
  limit: z.number().int().min(1).max(50).default(10),
});

export const deepResearchInputSchema = z.object({
  question: z.string().min(1),
  max_iterations: z.number().int().min(1).max(5).default(3),
  include_community_context: z.boolean().default(true),
  synthesize: z.boolean().default(true),
});

// --- Community tool schemas ---

export const getCommunitiesInputSchema = z.object({
  level: z.number().int().min(0).default(0),
  entity_id: z.string().uuid().optional(),
  search: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(20),
});

export const globalSearchInputSchema = z.object({
  query: z.string().min(1),
  level: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(20).default(5),
});
