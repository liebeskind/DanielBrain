import crypto from 'node:crypto';

/**
 * Verify HubSpot webhook signature (v3).
 * HubSpot signs with HMAC-SHA256 using the app secret.
 * Signature header: X-HubSpot-Signature-v3
 * Signed content: requestMethod + requestUri + requestBody + timestamp
 *
 * Timestamp header: X-HubSpot-Request-Timestamp (reject if > 5 minutes old)
 */
export function verifyHubSpotSignature(params: {
  signature: string | undefined;
  timestamp: string | undefined;
  requestMethod: string;
  requestUri: string;
  body: string;
  secret: string;
  maxAgeMs?: number;
}): boolean {
  const { signature, timestamp, requestMethod, requestUri, body, secret, maxAgeMs = 300_000 } = params;

  if (!signature || !timestamp) return false;

  // Reject stale requests (> 5 min by default)
  const ts = parseInt(timestamp, 10);
  if (isNaN(ts)) return false;
  if (Date.now() - ts > maxAgeMs) return false;

  // HubSpot v3 signature: HMAC-SHA256(secret, method + uri + body + timestamp)
  const signedContent = `${requestMethod}${requestUri}${body}${timestamp}`;
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(signedContent)
    .digest('base64');

  try {
    const expected = Buffer.from(expectedSignature);
    const actual = Buffer.from(signature);
    if (expected.length !== actual.length) return false;
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}
