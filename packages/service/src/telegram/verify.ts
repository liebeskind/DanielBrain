import crypto from 'node:crypto';

export function verifyTelegramSecret(
  headerValue: string | undefined,
  expectedSecret: string
): boolean {
  if (!headerValue) return false;
  if (headerValue.length !== expectedSecret.length) return false;

  return crypto.timingSafeEqual(
    Buffer.from(headerValue),
    Buffer.from(expectedSecret)
  );
}
