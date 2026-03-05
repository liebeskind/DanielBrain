import crypto from 'node:crypto';

/**
 * Verify Fathom webhook signature.
 * Uses HMAC-SHA256 with a base64-encoded secret (after stripping "whsec_" prefix).
 * Headers: webhook-id, webhook-timestamp, webhook-signature
 */
export function verifyFathomSignature(params: {
  webhookId: string | undefined;
  webhookTimestamp: string | undefined;
  webhookSignature: string | undefined;
  body: string;
  secret: string;
}): boolean {
  const { webhookId, webhookTimestamp, webhookSignature, body, secret } = params;

  if (!webhookId || !webhookTimestamp || !webhookSignature) return false;

  // Secret is prefixed with "whsec_" followed by base64-encoded key
  const secretBytes = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');

  // Signed content: "{webhook-id}.{webhook-timestamp}.{body}"
  const signedContent = `${webhookId}.${webhookTimestamp}.${body}`;
  const expectedSignature = crypto
    .createHmac('sha256', secretBytes)
    .update(signedContent)
    .digest('base64');

  // Multiple signatures separated by spaces, each prefixed with "v1,"
  const signatures = webhookSignature.split(' ');
  for (const sig of signatures) {
    const [version, value] = sig.split(',', 2);
    if (version === 'v1' && value) {
      try {
        const expected = Buffer.from(expectedSignature);
        const actual = Buffer.from(value);
        if (expected.length === actual.length && crypto.timingSafeEqual(expected, actual)) {
          return true;
        }
      } catch {
        // Length mismatch or other error — continue checking
      }
    }
  }

  return false;
}
