import { expect, it } from 'vitest';
import { createAuthenticator } from '../src/server/auth.js';
import { resolveServerStorageConfiguration } from '../src/server/http.js';

const subjectTokens = JSON.stringify([{
  subjectId: '11111111-1111-4111-8111-111111111111',
  role: 'caller',
  token: 'startup-subject-token-0000000000001',
}]);

it.each([
  ['filesystem legacy', {}, 'filesystem', false, false],
  ['filesystem subject without conversations', { SUBJECT_API_TOKENS: subjectTokens }, 'filesystem', false, true],
  ['filesystem conversations', { DATABASE_URL: 'postgresql://fixture', SUBJECT_API_TOKENS: subjectTokens }, 'filesystem', true, true],
  ['postgres journal only', { RUN_JOURNAL: 'postgres', DATABASE_URL: 'postgresql://fixture' }, 'postgres', false, false],
  ['postgres journal and conversations', { RUN_JOURNAL: 'postgres', DATABASE_URL: 'postgresql://fixture', SUBJECT_API_TOKENS: subjectTokens }, 'postgres', true, true],
] as const)('%s selects independent journal and conversation storage', (_name, env, mode, conversations, subjects) => {
  const selected = resolveServerStorageConfiguration(env);
  expect(selected.mode).toBe(mode);
  expect(selected.enableConversations).toBe(conversations);
  expect(selected.subjectTokens !== undefined).toBe(subjects);
  expect(selected.databaseUrl !== undefined).toBe(mode === 'postgres' || conversations);
});

it('preserves B1 fail-closed database configuration outside journal-only mode', () => {
  expect(() => resolveServerStorageConfiguration({ DATABASE_URL: 'postgresql://fixture' }))
    .toThrow('Conversation storage configuration is invalid');
  expect(() => resolveServerStorageConfiguration({ RUN_JOURNAL: 'filesystem', DATABASE_URL: 'postgresql://fixture' }))
    .toThrow('Conversation storage configuration is invalid');
});

it('rejects PostgreSQL journal mode without a database and unknown journal modes', () => {
  expect(() => resolveServerStorageConfiguration({ RUN_JOURNAL: 'postgres' }))
    .toThrow('PostgreSQL journal requires DATABASE_URL');
  expect(() => resolveServerStorageConfiguration({ RUN_JOURNAL: 'unexpected' }))
    .toThrow('RUN_JOURNAL must be filesystem or postgres');
});

it('keeps legacy caller and operator credentials usable in journal-only mode', () => {
  const selected = resolveServerStorageConfiguration({ RUN_JOURNAL: 'postgres', DATABASE_URL: 'postgresql://fixture' });
  const authenticate = createAuthenticator({
    callerToken: 'c'.repeat(32),
    operatorToken: 'o'.repeat(32),
    subjectTokens: selected.subjectTokens,
  });
  expect(authenticate('c'.repeat(32))).toBe('caller');
  expect(authenticate('o'.repeat(32))).toBe('operator');
  expect(selected.enableConversations).toBe(false);
});
