import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { Detector } from '../artifact/schema.js';
import { originAllowed, loadPolicy } from '../safety/policy.js';

export const AppProfile = z.object({
  appId: z.string(), entryUrl: z.string().url().optional(), detectors: z.array(Detector),
  routes: z.array(z.string()).optional(),
  forms: z.array(z.object({ path: z.string(), method: z.enum(['GET', 'POST']), control: z.string(), mutation: z.boolean(), token: z.boolean(), role: z.enum(['TELLER', 'SUPERVISOR']).optional() })).optional(),
  maskSelectors: z.array(z.string()).optional(),
});
export type AppProfile = z.infer<typeof AppProfile>;
export function loadProfile(name = 'cu-nexus') {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error('Invalid profile name');
  return AppProfile.parse(JSON.parse(readFileSync(new URL(`../../config/app-profiles/${name}.json`, import.meta.url), 'utf8')));
}
export interface LiveControl {
  url: string; destination: string; method: string; control: string; submit: boolean;
  operator: string; branch: string; facts: Record<string, string>; tokenPresent: boolean;
  error: boolean;
}
export function classify(profile: AppProfile, control: LiveControl, origins: string[]) {
  if (!originAllowed(origins, control.destination)) throw new Error('Control destination outside allowed origins');
  const path = new URL(control.destination).pathname;
  if (!profile.routes?.some(p => new RegExp(p).test(path))) throw new Error('Route is not permitted by profile');
  if (!control.submit) {
    if (control.method !== 'GET') throw new Error('Unknown mutation destination');
    return undefined;
  }
  const rule = profile.forms?.find(r => new RegExp(r.path).test(path) && r.method === control.method && r.control === control.control);
  if (!rule) throw new Error('Unknown form submission');
  if (rule.token && !control.tokenPresent) throw new Error('Transaction token is missing');
  return rule;
}

export function profilePolicy(profile: AppProfile) {
  return loadPolicy(process.env.POLICY_PATH ?? new URL(profile.appId === 'meridian' ? '../../config/policy-meridian.json' : '../../config/policy.json', import.meta.url));
}

export const FaultScenario = z.object({
  path: z.string().regex(/^\/members\/\d+\/(transfer|open-share|update|hold)$/),
  kind: z.enum(['validation', 'notfound', 'permission', 'timeout', 'maintenance', 'server']),
});
export type FaultScenario = z.infer<typeof FaultScenario>;
