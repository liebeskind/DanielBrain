import { describe, it, expect } from 'vitest';
import { verifyTelegramSecret } from '../../src/telegram/verify.js';

const SECRET = 'test-webhook-secret';

describe('verifyTelegramSecret', () => {
  it('passes for valid secret token', () => {
    expect(verifyTelegramSecret(SECRET, SECRET)).toBe(true);
  });

  it('rejects missing header', () => {
    expect(verifyTelegramSecret(undefined, SECRET)).toBe(false);
    expect(verifyTelegramSecret('', SECRET)).toBe(false);
  });

  it('rejects wrong token', () => {
    expect(verifyTelegramSecret('wrong-secret', SECRET)).toBe(false);
  });

  it('rejects tokens of different lengths', () => {
    expect(verifyTelegramSecret('short', SECRET)).toBe(false);
  });
});
