import { describe, expect, it } from 'vitest';
import { isLocalOnlyHost, redactSensitiveText } from '../src/index.js';

describe('Zeus security policy', () => {
  it('allows only local bind hosts by default', () => {
    expect(isLocalOnlyHost('127.0.0.1')).toBe(true);
    expect(isLocalOnlyHost('localhost')).toBe(true);
    expect(isLocalOnlyHost('0.0.0.0')).toBe(false);
  });

  it('redacts obvious tokens from logs', () => {
    expect(redactSensitiveText('token=abc123456789')).toBe('token=[REDACTED]');
  });

  it('redacts authorization headers cookies ssh private keys and env-style secrets', () => {
    const text = ['Authorization: Bearer real-token-value', 'Cookie: session=abc123; theme=dark', 'DATABASE_PASSWORD="real-db-password"', '-----BEGIN OPENSSH PRIVATE KEY-----', 'private-key-body', '-----END OPENSSH PRIVATE KEY-----'].join(
      '\n',
    );

    const redacted = redactSensitiveText(text);

    expect(redacted).toContain('Authorization: Bearer [REDACTED]');
    expect(redacted).toContain('Cookie: [REDACTED]');
    expect(redacted).toContain('DATABASE_PASSWORD=[REDACTED]');
    expect(redacted).toContain('[REDACTED SSH PRIVATE KEY]');
    expect(redacted).not.toContain('real-token-value');
    expect(redacted).not.toContain('session=abc123');
    expect(redacted).not.toContain('real-db-password');
    expect(redacted).not.toContain('private-key-body');
  });
});
