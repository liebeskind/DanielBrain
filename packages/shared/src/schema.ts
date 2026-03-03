import { z } from 'zod';

export const metadataSchema = z.object({
  thought_type: z.string().nullable().default(null),
  people: z.array(z.string()).default([]),
  topics: z.array(z.string()).default([]),
  action_items: z.array(z.string()).default([]),
  dates_mentioned: z.array(z.string()).default([]),
  sentiment: z.enum(['positive', 'negative', 'neutral', 'mixed']).nullable().default(null),
  summary: z.string().nullable().default(null),
});

export const semanticSearchInputSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(100).default(10),
  threshold: z.number().min(0).max(1).default(0.5),
  thought_type: z.string().optional(),
  person: z.string().optional(),
  topic: z.string().optional(),
  days_back: z.number().int().min(1).optional(),
});

export const listRecentInputSchema = z.object({
  days: z.number().int().min(1).default(7),
  limit: z.number().int().min(1).max(100).default(20),
  thought_type: z.string().optional(),
});

export const statsInputSchema = z.object({
  period: z.enum(['week', 'month', 'quarter', 'year', 'all']).default('month'),
});

export const saveThoughtInputSchema = z.object({
  content: z.string().min(1),
  source: z.string().default('mcp'),
});
