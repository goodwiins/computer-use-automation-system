import express, { type Request, type Response, type NextFunction } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { join, resolve } from 'node:path';
import type { LanguageModel } from 'ai';
import { z } from 'zod';
import { RequestError, Journal } from '../runtime/journal.js';
import { loadProfile, profilePolicy } from '../runtime/profile.js';
import { createChatHandlers } from './chat.js';
import { InvocationService, type Principal } from './service.js';

const Arguments = z.record(z.union([z.string(), z.number().finite()]));
const Invoke = z.object({ args: Arguments, operator: z.enum(['TELLER', 'SUPERVISOR']).optional() }).strict();
const hash = (value: string) => createHash('sha256').update(value).digest();

export function createApp(service: InvocationService, config: { callerToken: string; operatorToken: string; port: number; chatModel?: LanguageModel }) {
  if (config.callerToken.length < 32 || config.operatorToken.length < 32 || config.callerToken === config.operatorToken) throw new Error('Configure two distinct API credentials of at least 32 characters');
  const app = express();
  app.disable('x-powered-by');
  const origin = `http://127.0.0.1:${config.port}`;
  app.use((req, res, next) => {
    if (req.headers.host !== `127.0.0.1:${config.port}` || (req.headers.origin && req.headers.origin !== origin)) return res.status(403).json({ error: 'Host or Origin is not allowed' });
    res.set({ 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'", 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' });
    next();
  });
  app.use(express.json({ limit: '32kb' }));
  app.get('/', (_req, res) => res.sendFile(resolve('src/server/public/index.html')));
  for (const file of ['app.js', 'style.css']) app.get(`/${file}`, (_req, res) => res.sendFile(resolve('src/server/public', file)));
  app.use((req, res, next) => {
    const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    if (!token) return res.status(401).json({ error: 'Bearer credential required' });
    const principal: Principal | undefined = timingSafeEqual(hash(token), hash(config.operatorToken)) ? 'operator' : timingSafeEqual(hash(token), hash(config.callerToken)) ? 'caller' : undefined;
    if (!principal) return res.status(401).json({ error: 'Invalid credential' });
    res.locals.principal = principal; next();
  });
  app.get('/capabilities', (_req, res) => res.json({ principal: res.locals.principal, capabilities: service.catalog(res.locals.principal) }));
  app.get('/runs', (_req, res) => res.json(service.history(res.locals.principal)));
  app.get('/runs/:id', (req, res) => res.json(service.get(res.locals.principal, req.params.id!)));
  app.post('/capabilities/:id/invoke', (req, res) => {
    const body = Invoke.parse(req.body);
    res.status(202).json(service.invoke(res.locals.principal, req.params.id!, body.args, req.get('Idempotency-Key') ?? '', body.operator));
  });
  app.post('/runs/:id/decision', (req, res) => {
    const body = z.object({ approvalId: z.string().uuid(), decision: z.enum(['approve', 'retry', 'abort']) }).strict().parse(req.body);
    service.decide(res.locals.principal, req.params.id!, body.approvalId, body.decision);
    res.json({ accepted: true });
  });
  app.get('/runs/:id/evidence/:file', (req, res) => {
    const run = service.get(res.locals.principal, req.params.id!);
    if (!run.evidence.includes(req.params.file!)) throw new RequestError(404, 'Unknown evidence file');
    res.sendFile(resolve(join(service.evidenceDir, req.params.id!, req.params.file!)));
  });
  const chat = createChatHandlers(service, config.chatModel);
  app.post('/chat', chat.legacy);
  app.post('/api/chat', chat.stream);
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = error instanceof RequestError ? error.status : error instanceof z.ZodError || error instanceof SyntaxError ? 400 : 500;
    res.status(status).json({ error: error instanceof RequestError ? error.message : status === 400 ? 'Request does not match the contract' : 'Request failed; inspect safe run evidence or server configuration' });
  });
  return app;
}

export async function serve(profileName = 'meridian') {
  const profile = loadProfile(profileName);
  const policy = profilePolicy(profile);
  const evidenceDir = process.env.EVIDENCE_DIR ?? 'evidence/meridian';
  const journal = new Journal(join(evidenceDir, 'journal'), process.env.JOURNAL_HMAC_KEY ?? '');
  try {
    const service = new InvocationService(journal, policy, profile, evidenceDir, (process.env.CALLER_CAPABILITIES ?? '').split(',').filter(Boolean), process.env.ARTIFACT_DIR ?? 'artifacts');
    const port = Number(process.env.PORT ?? 4180);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid PORT');
    const app = createApp(service, { callerToken: process.env.CALLER_API_TOKEN ?? '', operatorToken: process.env.OPERATOR_API_TOKEN ?? '', port });
    const server = app.listen(port, '127.0.0.1', () => console.log(`Dashboard: http://127.0.0.1:${port}`));
    server.on('error', () => { journal.close(); process.exitCode = 1; });
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
      server.close(); void service.close().finally(() => { journal.close(); });
    });
  } catch (error) { journal.close(); throw error; }
}
