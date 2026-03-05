import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { verifyFathomSignature } from '../../src/fathom/verify.js';

const secret = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
const secretBytes = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');

function sign(msgId: string, timestamp: string, body: string): string {
  const signedContent = `${msgId}.${timestamp}.${body}`;
  const sig = crypto.createHmac('sha256', secretBytes).update(signedContent).digest('base64');
  return `v1,${sig}`;
}

describe('verifyFathomSignature', () => {
  const body = JSON.stringify({ recording_id: 123, title: 'Test' });
  const webhookId = 'msg_abc123';
  const webhookTimestamp = '1700000000';

  it('accepts valid signature', () => {
    const sig = sign(webhookId, webhookTimestamp, body);
    expect(
      verifyFathomSignature({ webhookId, webhookTimestamp, webhookSignature: sig, body, secret })
    ).toBe(true);
  });

  it('rejects invalid signature', () => {
    expect(
      verifyFathomSignature({
        webhookId,
        webhookTimestamp,
        webhookSignature: 'v1,invalidsignature',
        body,
        secret,
      })
    ).toBe(false);
  });

  it('rejects missing headers', () => {
    expect(
      verifyFathomSignature({
        webhookId: undefined,
        webhookTimestamp,
        webhookSignature: 'v1,abc',
        body,
        secret,
      })
    ).toBe(false);
  });

  it('accepts when valid signature is among multiple', () => {
    const validSig = sign(webhookId, webhookTimestamp, body);
    const multi = `v1,invalidsig ${validSig}`;
    expect(
      verifyFathomSignature({ webhookId, webhookTimestamp, webhookSignature: multi, body, secret })
    ).toBe(true);
  });

  it('rejects tampered body', () => {
    const sig = sign(webhookId, webhookTimestamp, body);
    expect(
      verifyFathomSignature({
        webhookId,
        webhookTimestamp,
        webhookSignature: sig,
        body: body + 'tampered',
        secret,
      })
    ).toBe(false);
  });
});
