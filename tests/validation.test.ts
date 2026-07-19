import { describe, expect, it } from 'vitest';
import {
  buildPreview,
  isValidLocalPart,
  normalizeAddress,
  safeFilename,
  slugifyPurpose,
} from '../src/shared/validation';

describe('mailbox validation', () => {
  it('normalizes valid email addresses', () => {
    expect(normalizeAddress(' Signup.GitHub+1@Emomo.Net. ')).toBe('signup.github+1@emomo.net');
  });

  it('rejects unsafe local parts', () => {
    expect(isValidLocalPart('valid-alias')).toBe(true);
    expect(isValidLocalPart('../escape')).toBe(false);
    expect(isValidLocalPart('-starts-wrong')).toBe(false);
    expect(normalizeAddress('two@@emomo.net')).toBeNull();
  });

  it('builds bounded previews and storage-safe filenames', () => {
    expect(buildPreview('hello\n\n world', 20)).toBe('hello world');
    expect(safeFilename('../invoice\u0000.pdf', 'file')).toBe('..-invoice.pdf');
    expect(slugifyPurpose('GitHub Registration')).toBe('github-registration');
    expect(slugifyPurpose('注册用途')).toBe('box');
  });
});
