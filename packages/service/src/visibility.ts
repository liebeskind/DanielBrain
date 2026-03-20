import type { Request } from 'express';

/**
 * Extract visibility tags from the request's user context.
 * Returns null when no filtering should be applied (owner role or no user context).
 * Returns string[] when filtering is needed.
 */
export function getVisibilityTags(req: Request): string[] | null {
  if (!req.userContext) return null;
  if (req.userContext.visibilityTags.length === 0) return null;
  return req.userContext.visibilityTags;
}

/**
 * Compute default visibility for a thought based on its source and source metadata.
 *
 * Visibility tags:
 * - 'company'              — visible to all authenticated users
 * - 'owner'                — visible only to the person who submitted it
 * - 'user:<uuid>'          — visible to a specific user
 * - 'channel:<channel_id>' — visible to members of a Slack private channel
 *
 * Source-determined defaults:
 * - slack + public channel   → ['company']
 * - slack + private channel  → ['channel:<channel_id>']
 * - slack + DM               → ['user:<user1>', 'user:<user2>']
 * - slack + group DM         → ['user:<user1>', ..., 'user:<userN>']
 * - telegram                 → ['owner']
 * - fathom                   → ['owner'] (promoted manually)
 * - mcp / manual / other     → ['owner']
 */
export function computeSourceVisibility(
  source: string,
  sourceMeta?: Record<string, unknown> | null,
  ownerId?: string | null,
): string[] {
  // HubSpot: per-object-type visibility
  if (source === 'hubspot' && sourceMeta) {
    const objectType = sourceMeta.object_type as string | undefined;
    if (objectType && ['contact', 'company', 'deal'].includes(objectType)) {
      return ['company'];
    }
    // Emails and notes are private to the record owner
    if (ownerId) return [`user:${ownerId}`];
    return ['owner'];
  }

  if (source === 'slack' && sourceMeta) {
    const channelType = sourceMeta.channel_type as string | undefined;
    const channelId = sourceMeta.channel_id as string | undefined;

    if (channelType === 'public' || channelType === 'channel') {
      return ['company'];
    }

    if (channelType === 'private' && channelId) {
      return [`channel:${channelId}`];
    }

    if (channelType === 'dm' || channelType === 'im') {
      // DM between two users — extract user IDs from source meta
      const users = extractSlackUserIds(sourceMeta);
      if (users.length > 0) {
        return users.map(u => `user:${u}`);
      }
    }

    if (channelType === 'group_dm' || channelType === 'mpim') {
      const users = extractSlackUserIds(sourceMeta);
      if (users.length > 0) {
        return users.map(u => `user:${u}`);
      }
    }
  }

  // All other sources default to owner-only
  if (ownerId) return [`user:${ownerId}`];
  return ['owner'];
}

/**
 * Extract Slack user IDs from source metadata (participants, sender, etc.)
 */
function extractSlackUserIds(sourceMeta: Record<string, unknown>): string[] {
  const ids: string[] = [];

  // Slack event metadata may contain user IDs
  if (typeof sourceMeta.user_id === 'string') ids.push(sourceMeta.user_id);
  if (typeof sourceMeta.sender_id === 'string' && !ids.includes(sourceMeta.sender_id)) {
    ids.push(sourceMeta.sender_id);
  }

  // structured.participants may have platform_id for Slack users
  const structured = sourceMeta.structured as { participants?: Array<{ platform_id?: string | null }> } | undefined;
  if (structured?.participants) {
    for (const p of structured.participants) {
      if (p.platform_id && !ids.includes(p.platform_id)) {
        ids.push(p.platform_id);
      }
    }
  }

  return ids;
}
