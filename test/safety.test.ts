import { describe, expect, it } from 'vitest';
import { checkAction, Policy } from '../src/safety/policy.js';
import { originAllowed } from '../src/safety/policy.js';
import { Redactor } from '../src/safety/redact.js';

const policy = Policy.parse({
  allowedOrigins: ['http://localhost:4173'],
  allowedActions: ['navigate', 'click', 'fill', 'select', 'extract', 'assert'],
  riskHandling: { read: 'allow', reversible_write: 'allow', irreversible: 'escalate' },
});

describe('policy.checkAction', () => {
  it('allows a read inside the allowlist', () => {
    expect(checkAction(policy, 'click', 'http://localhost:4173/members/1', 'read')).toEqual({ verdict: 'allow' });
  });
  it('denies any origin outside the allowlist', () => {
    const v = checkAction(policy, 'navigate', 'https://evil.example.com/x', 'read');
    expect(v.verdict).toBe('deny');
  });
  it('does not leak query strings into denial reasons', () => {
    const v = checkAction(policy, 'navigate', 'https://evil.example.com/x?ssn=123456789', 'read');
    expect(v.verdict === 'deny' && v.reason).not.toContain('ssn=123456789');
  });
  it('routes irreversible actions to a human', () => {
    const v = checkAction(policy, 'click', 'http://localhost:4173/commit', 'irreversible');
    expect(v.verdict).toBe('needs_human');
  });
  it('denies action types missing from the allowlist', () => {
    const readOnly = Policy.parse({ ...policy, allowedActions: ['navigate', 'click', 'extract', 'assert'] });
    expect(checkAction(readOnly, 'fill', 'http://localhost:4173/', 'reversible_write').verdict).toBe('deny');
  });
  it('treats relative URLs as same-origin', () => {
    expect(checkAction(policy, 'navigate', '/members/search', 'read')).toEqual({ verdict: 'allow' });
  });
  it('denies protocol-relative URLs — scheme-less authority is not relative', () => {
    expect(originAllowed(policy.allowedOrigins, '//evil.example.com/x')).toBe(false);
    expect(checkAction(policy, 'navigate', '//evil.example.com/x', 'read').verdict).toBe('deny');
  });
  it('denies backslash-relative URLs that browsers treat as authority', () => {
    expect(originAllowed(policy.allowedOrigins, '\\\\evil.example.com/x')).toBe(false);
  });
  it('denies backslash-spelled authority forms (WHATWG treats \\ as / for http)', () => {
    for (const u of ['/\\evil.example.com/x', '\\/evil.example.com/x', '/\\\\evil.example.com/x', '\\\\evil.example.com/x']) {
      expect(originAllowed(policy.allowedOrigins, u), u).toBe(false);
      expect(checkAction(policy, 'navigate', u, 'read').verdict, u).toBe('deny');
    }
  });

  it('still allows genuinely relative paths and query-only URLs', () => {
    expect(originAllowed(policy.allowedOrigins, '/members/search')).toBe(true);
    expect(originAllowed(policy.allowedOrigins, '?sim=maintenance')).toBe(true);
  });

  it('denies non-http schemes that parse but have a null origin', () => {
    expect(originAllowed(policy.allowedOrigins, 'javascript:alert(1)')).toBe(false);
    expect(originAllowed(policy.allowedOrigins, 'about:blank')).toBe(false);
  });
});

describe('Redactor', () => {
  it('masks registered sensitive values everywhere, including URLs', () => {
    const r = new Redactor();
    r.addSensitiveValues(['987654321']);
    const out = r.redact({ url: 'http://x/members/987654321', note: 'member 987654321 checked' });
    expect(JSON.stringify(out)).not.toContain('987654321');
  });
  it('masks credential-shaped strings defensively', () => {
    const r = new Redactor();
    const out = r.redactString('auth with sk-abcdefghijklmnop1234 done');
    expect(out).not.toContain('sk-abcdefghijklmnop1234');
  });
  it('leaves ordinary values alone', () => {
    const r = new Redactor();
    expect(r.redact({ balance: '4,250.13' })).toEqual({ balance: '4,250.13' });
  });
});
