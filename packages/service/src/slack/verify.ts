import crypto from 'node:crypto';

interface VerifyParams {
  signature: string;
  timestamp: string;
  body: string;
  signingSecret: string;
}

const MAX_AGE_SECONDS = 300; // 5 minutes

export function verifySlackSignature(params: VerifyParams): boolean {
  const { signature, timestamp, body, signingSecret } = params;

  if (!signature || !timestamp) return false;

  // Reject old timestamps (replay attack protection)
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp, 10)) > MAX_AGE_SECONDS) return false;

  const sigBasestring = `v0:${timestamp}:${body}`;
  const hmac = crypto.createHmac('sha256', signingSecret);
  hmac.update(sigBasestring);
  const expectedSignature = `v0=${hmac.digest('hex')}`;

  // Timing-safe comparison
  if (signature.length !== expectedSignature.length) return false;
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  );
}
