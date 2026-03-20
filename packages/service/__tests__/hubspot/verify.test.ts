import { describe, it, expect, vi, afterEach } from 'vitest';
import crypto from 'node:crypto';
import { verifyHubSpotSignature } from '../../src/hubspot/verify.js';

const SECRET = 'test-app-secret-12345';

function sign(method: string, uri: string, body: string, timestamp: string): string {
  const signedContent = `${method}${uri}${body}${timestamp}`;
  return crypto.createHmac('sha256', SECRET).update(signedContent).digest('base64');
}

describe('verifyHubSpotSignature', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('accepts valid signature', () => {
    const now = String(Date.now());
    const body = '[{"objectId":123}]';
    const signature = sign('POST', 'https://brain.example.com/hubspot/events', body, now);

    expect(verifyHubSpotSignature({
      signature,
      timestamp: now,
      requestMethod: 'POST',
      requestUri: 'https://brain.example.com/hubspot/events',
      body,
      secret: SECRET,
    })).toBe(true);
  });

  it('rejects wrong signature', () => {
    const now = String(Date.now());
    const body = '[{"objectId":123}]';

    expect(verifyHubSpotSignature({
      signature: 'wrong-signature',
      timestamp: now,
      requestMethod: 'POST',
      requestUri: 'https://brain.example.com/hubspot/events',
      body,
      secret: SECRET,
    })).toBe(false);
  });

  it('rejects missing signature', () => {
    expect(verifyHubSpotSignature({
      signature: undefined,
      timestamp: String(Date.now()),
      requestMethod: 'POST',
      requestUri: '/hubspot/events',
      body: '[]',
      secret: SECRET,
    })).toBe(false);
  });

  it('rejects missing timestamp', () => {
    expect(verifyHubSpotSignature({
      signature: 'abc',
      timestamp: undefined,
      requestMethod: 'POST',
      requestUri: '/hubspot/events',
      body: '[]',
      secret: SECRET,
    })).toBe(false);
  });

  it('rejects stale timestamp (> 5 min)', () => {
    const staleTs = String(Date.now() - 6 * 60 * 1000);
    const body = '[]';
    const signature = sign('POST', '/hubspot/events', body, staleTs);

    expect(verifyHubSpotSignature({
      signature,
      timestamp: staleTs,
      requestMethod: 'POST',
      requestUri: '/hubspot/events',
      body,
      secret: SECRET,
    })).toBe(false);
  });

  it('accepts custom maxAgeMs', () => {
    const staleTs = String(Date.now() - 4 * 60 * 1000); // 4 min ago
    const body = '[]';
    const signature = sign('POST', '/hubspot/events', body, staleTs);

    // Default 5 min — should pass
    expect(verifyHubSpotSignature({
      signature,
      timestamp: staleTs,
      requestMethod: 'POST',
      requestUri: '/hubspot/events',
      body,
      secret: SECRET,
      maxAgeMs: 300_000,
    })).toBe(true);

    // 3 min max — should fail
    expect(verifyHubSpotSignature({
      signature,
      timestamp: staleTs,
      requestMethod: 'POST',
      requestUri: '/hubspot/events',
      body,
      secret: SECRET,
      maxAgeMs: 180_000,
    })).toBe(false);
  });

  it('rejects non-numeric timestamp', () => {
    expect(verifyHubSpotSignature({
      signature: 'abc',
      timestamp: 'not-a-number',
      requestMethod: 'POST',
      requestUri: '/hubspot/events',
      body: '[]',
      secret: SECRET,
    })).toBe(false);
  });

  it('rejects tampered body', () => {
    const now = String(Date.now());
    const body = '[{"objectId":123}]';
    const signature = sign('POST', '/hubspot/events', body, now);

    expect(verifyHubSpotSignature({
      signature,
      timestamp: now,
      requestMethod: 'POST',
      requestUri: '/hubspot/events',
      body: '[{"objectId":456}]', // tampered
      secret: SECRET,
    })).toBe(false);
  });
});
