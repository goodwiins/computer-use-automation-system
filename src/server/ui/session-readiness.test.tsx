import { expect, it } from 'vitest';
import { completedActionReady, validateReadinessMetadata, type Run, type Session } from './session.js';

const session = (readinessRequired?: boolean): Session => ({
  token: 'offline', principal: 'caller', readinessRequired, availability: [],
  capabilities: [{ id: 'meridian-funds-transfer' }] as Session['capabilities'],
  operationContracts: [],
});
const run = (state: string, identity?: string) => ({
  capability: 'meridian-funds-transfer', state,
  ...(identity ? { memberIdentity: { status: identity } } : {}),
}) as Run;

it('uses explicit readiness policy rather than capability names, with a conservative missing-policy default', () => {
  expect(completedActionReady(session(false), run('success'))).toBe(true);
  expect(completedActionReady(session(true), run('success'))).toBe(false);
  expect(completedActionReady(session(), run('success'))).toBe(false);
  expect(completedActionReady({ ...session(false), availability: undefined }, run('success'))).toBe(false);
  expect(completedActionReady({ ...session(false), capabilities: [] }, run('success'))).toBe(false);
});

it.each(['reserved', 'running', 'dispatching', 'awaiting-human', 'POST_OUTCOME_UNKNOWN'])('retains the non-Meridian action hold for %s', state => {
  expect(completedActionReady(session(false), run(state))).toBe(false);
});

it('retains the non-Meridian action hold while member identity is pending', () => {
  expect(completedActionReady(session(false), run('success', 'pending'))).toBe(false);
});

it('accepts only explicit boolean readiness metadata and defaults missing metadata to required', () => {
  expect(validateReadinessMetadata({ readinessRequired: false })).toBe(false);
  expect(validateReadinessMetadata({ readinessRequired: true })).toBe(true);
  expect(validateReadinessMetadata({})).toBe(true);
  for (const value of [null, [], { readinessRequired: 'false' }, { readinessRequired: null }, { readinessRequired: 0 }]) {
    expect(() => validateReadinessMetadata(value)).toThrow(/readiness metadata/);
  }
});
