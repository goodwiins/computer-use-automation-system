import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export type Role = 'caller' | 'operator';
export type SubjectPrincipal = { subjectId: string; role: Role };
export type Principal = Role | SubjectPrincipal;
export type SubjectCredential = SubjectPrincipal & { token: string };

const credential = z.object({
  subjectId: z.string().uuid().transform(value => value.toLowerCase()),
  role: z.enum(['caller', 'operator']),
  token: z.string().regex(/^[\x21-\x7e]{32,200}$/),
}).strict();
const credentials = z.array(credential).min(1);
const hash = (value: string) => createHash('sha256').update(value).digest();

function validateSubjectCredentials(value: unknown): SubjectCredential[] {
  const parsed = credentials.safeParse(value);
  if (!parsed.success) throw new Error('Invalid subject credential configuration');
  const subjects = new Set<string>(), tokens = new Set<string>();
  for (const entry of parsed.data) {
    if (subjects.has(entry.subjectId) || tokens.has(entry.token))
      throw new Error('Invalid subject credential configuration');
    subjects.add(entry.subjectId);
    tokens.add(entry.token);
  }
  return parsed.data;
}

export function principalRole(principal: Principal): Role {
  return typeof principal === 'string' ? principal : principal.role;
}

export function principalKey(principal: Principal): string {
  return typeof principal === 'string' ? principal : `subject:${principal.subjectId}`;
}

export function canAccessRun(principal: Principal, owner: string): boolean {
  if (typeof principal !== 'string') return owner === principalKey(principal);
  return !owner.startsWith('subject:') && (principal === 'operator' || owner === principal);
}

export function callerPrincipal(principal: Principal): Principal {
  return typeof principal === 'string' ? 'caller' : { subjectId: principal.subjectId, role: 'caller' };
}

export function parseSubjectCredentials(value: string | undefined): SubjectCredential[] | undefined {
  if (value === undefined) return undefined;
  try { return validateSubjectCredentials(JSON.parse(value)); }
  catch { throw new Error('Invalid subject credential configuration'); }
}

export function createAuthenticator(config: {
  callerToken: string;
  operatorToken: string;
  subjectTokens?: SubjectCredential[];
}): (token: string) => Principal | undefined {
  if (config.subjectTokens !== undefined) {
    const entries = validateSubjectCredentials(config.subjectTokens).map(({ token, ...principal }) => ({ principal, hash: hash(token) }));
    return token => entries.find(entry => timingSafeEqual(hash(token), entry.hash))?.principal;
  }
  if (config.callerToken.length < 32 || config.operatorToken.length < 32 || config.callerToken === config.operatorToken)
    throw new Error('Configure two distinct API credentials of at least 32 characters');
  const caller = hash(config.callerToken), operator = hash(config.operatorToken);
  return token => {
    const candidate = hash(token);
    return timingSafeEqual(candidate, operator) ? 'operator' : timingSafeEqual(candidate, caller) ? 'caller' : undefined;
  };
}
