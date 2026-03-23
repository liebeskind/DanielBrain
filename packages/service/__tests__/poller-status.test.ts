import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordPollerSuccess,
  recordPollerError,
  getPollerStatuses,
  _resetForTest,
} from '../src/poller-status.js';

describe('poller-status', () => {
  beforeEach(() => {
    _resetForTest();
  });

  it('starts empty', () => {
    expect(getPollerStatuses()).toEqual({});
  });

  it('records success timestamps', () => {
    recordPollerSuccess('queue-poller');
    const statuses = getPollerStatuses();
    expect(statuses['queue-poller']).toBeDefined();
    expect(statuses['queue-poller'].lastSuccess).toBeTruthy();
    expect(statuses['queue-poller'].lastError).toBeNull();
    expect(statuses['queue-poller'].lastErrorMessage).toBeNull();
  });

  it('records error timestamps with message', () => {
    recordPollerError('profile-refresher', 'Connection timeout');
    const statuses = getPollerStatuses();
    expect(statuses['profile-refresher'].lastError).toBeTruthy();
    expect(statuses['profile-refresher'].lastErrorMessage).toBe('Connection timeout');
    expect(statuses['profile-refresher'].lastSuccess).toBeNull();
  });

  it('tracks multiple pollers independently', () => {
    recordPollerSuccess('queue-poller');
    recordPollerError('hubspot-sync', 'Rate limited');
    const statuses = getPollerStatuses();
    expect(Object.keys(statuses)).toEqual(['queue-poller', 'hubspot-sync']);
  });

  it('preserves success when error occurs', () => {
    recordPollerSuccess('queue-poller');
    recordPollerError('queue-poller', 'Temporary failure');
    const statuses = getPollerStatuses();
    expect(statuses['queue-poller'].lastSuccess).toBeTruthy();
    expect(statuses['queue-poller'].lastError).toBeTruthy();
  });

  it('returns copies (not references)', () => {
    recordPollerSuccess('test');
    const a = getPollerStatuses();
    const b = getPollerStatuses();
    expect(a).toEqual(b);
    expect(a['test']).not.toBe(b['test']); // Different objects
  });
});
