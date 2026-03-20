import { describe, it, expect } from 'vitest';
import { computeSourceVisibility, getVisibilityTags } from '../src/visibility.js';

describe('computeSourceVisibility', () => {
  it('returns company for slack public channel', () => {
    expect(computeSourceVisibility('slack', { channel_type: 'public' }))
      .toEqual(['company']);
    expect(computeSourceVisibility('slack', { channel_type: 'channel' }))
      .toEqual(['company']);
  });

  it('returns channel tag for slack private channel', () => {
    expect(computeSourceVisibility('slack', { channel_type: 'private', channel_id: 'C123' }))
      .toEqual(['channel:C123']);
  });

  it('returns user tags for slack DM', () => {
    expect(computeSourceVisibility('slack', {
      channel_type: 'dm',
      user_id: 'U1',
      structured: { participants: [{ platform_id: 'U2' }] },
    })).toEqual(['user:U1', 'user:U2']);
  });

  it('returns user tags for slack group DM', () => {
    expect(computeSourceVisibility('slack', {
      channel_type: 'group_dm',
      structured: { participants: [{ platform_id: 'U1' }, { platform_id: 'U2' }, { platform_id: 'U3' }] },
    })).toEqual(['user:U1', 'user:U2', 'user:U3']);
  });

  it('returns owner for telegram', () => {
    expect(computeSourceVisibility('telegram', {})).toEqual(['owner']);
  });

  it('returns company for hubspot contacts', () => {
    expect(computeSourceVisibility('hubspot', { object_type: 'contact' }))
      .toEqual(['company']);
  });

  it('returns company for hubspot companies', () => {
    expect(computeSourceVisibility('hubspot', { object_type: 'company' }))
      .toEqual(['company']);
  });

  it('returns company for hubspot deals', () => {
    expect(computeSourceVisibility('hubspot', { object_type: 'deal' }))
      .toEqual(['company']);
  });

  it('returns owner for hubspot notes', () => {
    expect(computeSourceVisibility('hubspot', { object_type: 'note' }))
      .toEqual(['owner']);
  });

  it('uses ownerId for hubspot notes when provided', () => {
    expect(computeSourceVisibility('hubspot', { object_type: 'note' }, 'user-123'))
      .toEqual(['user:user-123']);
  });

  it('returns owner for fathom', () => {
    expect(computeSourceVisibility('fathom', {})).toEqual(['owner']);
  });

  it('returns owner for manual', () => {
    expect(computeSourceVisibility('manual', {})).toEqual(['owner']);
  });

  it('returns owner for mcp', () => {
    expect(computeSourceVisibility('mcp', null)).toEqual(['owner']);
  });

  it('uses ownerId when provided for non-slack sources', () => {
    expect(computeSourceVisibility('manual', null, 'user-123'))
      .toEqual(['user:user-123']);
    expect(computeSourceVisibility('fathom', {}, 'user-456'))
      .toEqual(['user:user-456']);
  });

  it('does not use ownerId for slack (source-determined)', () => {
    expect(computeSourceVisibility('slack', { channel_type: 'public' }, 'user-789'))
      .toEqual(['company']);
  });

  it('handles null/undefined source meta', () => {
    expect(computeSourceVisibility('slack', null)).toEqual(['owner']);
    expect(computeSourceVisibility('slack', undefined)).toEqual(['owner']);
  });
});

describe('getVisibilityTags', () => {
  it('returns null when userContext is undefined', () => {
    const req = {} as any;
    expect(getVisibilityTags(req)).toBeNull();
  });

  it('returns null when userContext is null-ish', () => {
    const req = { userContext: undefined } as any;
    expect(getVisibilityTags(req)).toBeNull();
  });

  it('returns null when visibilityTags is empty array (owner role)', () => {
    const req = {
      userContext: {
        userId: 'u1',
        email: 'owner@test.com',
        displayName: 'Owner',
        role: 'owner',
        visibilityTags: [],
      },
    } as any;
    expect(getVisibilityTags(req)).toBeNull();
  });

  it('returns tags when visibilityTags is non-empty (member role)', () => {
    const tags = ['company', 'user:u1'];
    const req = {
      userContext: {
        userId: 'u1',
        email: 'member@test.com',
        displayName: 'Member',
        role: 'member',
        visibilityTags: tags,
      },
    } as any;
    expect(getVisibilityTags(req)).toEqual(tags);
  });

  it('returns the exact same array reference', () => {
    const tags = ['company', 'user:u2'];
    const req = {
      userContext: {
        userId: 'u2',
        email: 'admin@test.com',
        displayName: 'Admin',
        role: 'admin',
        visibilityTags: tags,
      },
    } as any;
    expect(getVisibilityTags(req)).toBe(tags);
  });

  it('returns tags with channel scoping', () => {
    const tags = ['company', 'user:u3', 'channel:C123'];
    const req = {
      userContext: {
        userId: 'u3',
        email: 'user@test.com',
        displayName: 'User',
        role: 'member',
        visibilityTags: tags,
      },
    } as any;
    expect(getVisibilityTags(req)).toEqual(tags);
  });
});
