import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { verifySlackSignature } from '../../src/slack/verify.js';

function makeSignature(secret: string, timestamp: string, body: string): string {
  const sigBasestring = `v0:${timestamp}:${body}`;
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(sigBasestring);
  return `v0=${hmac.digest('hex')}`;
}

const SECRET = 'test-signing-secret';

describe('verifySlackSignature', () => {
  it('passes for valid signature', () => {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const body = '{"event":"test"}';
    const signature = makeSignature(SECRET, timestamp, body);

    const result = verifySlackSignature({
      signature,
      timestamp,
      body,
      signingSecret: SECRET,
    });

    expect(result).toBe(true);
  });

  it('rejects invalid signature', () => {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const body = '{"event":"test"}';

    const result = verifySlackSignature({
      signature: 'v0=invalidsig',
      timestamp,
      body,
      signingSecret: SECRET,
    });

    expect(result).toBe(false);
  });

  it('rejects expired timestamp (>5 min old)', () => {
    const fiveMinutesAgo = (Math.floor(Date.now() / 1000) - 301).toString();
    const body = '{"event":"test"}';
    const signature = makeSignature(SECRET, fiveMinutesAgo, body);

    const result = verifySlackSignature({
      signature,
      timestamp: fiveMinutesAgo,
      body,
      signingSecret: SECRET,
    });

    expect(result).toBe(false);
  });

  it('rejects missing headers', () => {
    expect(
      verifySlackSignature({
        signature: '',
        timestamp: '',
        body: '{}',
        signingSecret: SECRET,
      })
    ).toBe(false);
  });
});
