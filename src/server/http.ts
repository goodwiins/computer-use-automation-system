import express, { type Request, type Response, type NextFunction } from 'express';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { join, resolve } from 'node:path';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { LanguageModel } from 'ai';
import { Pool } from 'pg';
import { z } from 'zod';
import { RequestError, type RunJournal } from '../runtime/journal.js';
import { openRunJournal } from '../runtime/open-journal.js';
import { loadProfile, profilePolicy } from '../runtime/profile.js';
import { createChatHandlers } from './chat.js';
import { InvocationService } from './service.js';
import { createAuthenticator, parseSubjectCredentials, principalRole, type SubjectCredential } from './auth.js';
import { conversationRouter } from './conversation-http.js';
import { ConversationStore } from './conversations.js';

const Arguments = z.record(z.union([z.string(), z.number().finite()]));
const Invoke = z.object({ args: Arguments, operator: z.enum(['TELLER', 'SUPERVISOR']).optional(), lookupOnly: z.literal(true).optional() }).strict();
const hash = (value: string) => createHash('sha256').update(value).digest();
const asyncRoute = (handler: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => { void handler(req, res).catch(next); };

export type ServerStorageConfiguration = {
  mode: 'filesystem' | 'postgres';
  databaseUrl?: string;
  subjectTokens?: SubjectCredential[];
  enableConversations: boolean;
};

export function resolveServerStorageConfiguration(env: NodeJS.ProcessEnv = process.env): ServerStorageConfiguration {
  const mode = env.RUN_JOURNAL ?? 'filesystem';
  if (mode !== 'filesystem' && mode !== 'postgres') throw new Error('RUN_JOURNAL must be filesystem or postgres');
  const subjectTokens = parseSubjectCredentials(env.SUBJECT_API_TOKENS);
  const databaseUrl = env.DATABASE_URL || undefined;
  if (databaseUrl && !subjectTokens && mode !== 'postgres') throw new Error('Conversation storage configuration is invalid');
  if (mode === 'postgres' && !databaseUrl) throw new Error('PostgreSQL journal requires DATABASE_URL');
  return { mode, databaseUrl, subjectTokens, enableConversations: Boolean(databaseUrl && subjectTokens) };
}

export function createApp(service: InvocationService, config: { callerToken: string; operatorToken: string; subjectTokens?: SubjectCredential[]; conversations?: ConversationStore; port: number; chatModel?: LanguageModel; uiDir?: string; localTellerLogin?: { teller: string; supervisor: string } }) {
  const authenticate = createAuthenticator(config);
  const localTellerLogin = config.subjectTokens ? undefined : config.localTellerLogin;
  const uiDir = config.uiDir ?? resolve('out');
  const html = existsSync(join(uiDir, 'index.html')) ? readFileSync(join(uiDir, 'index.html'), 'utf8') : '';
  // Next's exported bootstrap scripts are immutable; authorize their exact contents.
  const scriptHashes = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
    .filter(match => match[1]).map(match => `'sha256-${createHash('sha256').update(match[1]!).digest('base64')}'`).join(' ');
  const app = express();
  app.disable('x-powered-by');
  const origin = `http://127.0.0.1:${config.port}`;
  // Local demo callers share the existing caller principal; restart revokes this token.
  const localTellerToken = localTellerLogin ? randomBytes(32).toString('hex') : undefined;
  app.use((req, res, next) => {
    if (req.headers.host !== `127.0.0.1:${config.port}` || (req.headers.origin && req.headers.origin !== origin)) return res.status(403).json({ error: 'Host or Origin is not allowed' });
    res.set({ 'Content-Security-Policy': `default-src 'self'; script-src 'self' ${scriptHashes}; style-src 'self'; img-src 'self' blob:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' });
    next();
  });
  app.use(express.json({ limit: '32kb' }));
  app.get('/', (_req, res) => res.sendFile(join(uiDir, 'index.html')));
  app.use('/_next', express.static(join(uiDir, '_next'), { index: false, dotfiles: 'deny' }));
  app.get('/session/options', (_req, res) => res.json({ localTellerLogin: localTellerLogin ?? null }));
  app.post('/session/teller', (req, res) => {
    if (!localTellerToken) return res.status(404).json({ error: 'Local teller login is disabled' });
    if (req.get('Origin') !== origin || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '')) {
      return res.status(403).json({ error: 'Local same-origin login required' });
    }
    z.object({}).strict().parse(req.body);
    res.json({ token: localTellerToken });
  });
  app.use((req, res, next) => {
    const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    if (!token) return res.status(401).json({ error: 'Bearer credential required' });
    const principal = authenticate(token) ?? (localTellerToken && timingSafeEqual(hash(token), hash(localTellerToken)) ? 'caller' : undefined);
    if (!principal) return res.status(401).json({ error: 'Invalid credential' });
    res.locals.principal = principal; next();
  });
  app.get('/capabilities', asyncRoute(async (_req, res) => {
    const principal = res.locals.principal;
    res.json({ principal: principalRole(principal), ...(typeof principal === 'string' ? {} : { subjectId: principal.subjectId }), capabilities: service.catalog(principal),
      availability: typeof service.availability === 'function' ? await service.availability(principal) : null });
  }));
  app.get('/runs', asyncRoute(async (_req, res) => { res.json(await service.history(res.locals.principal)); }));
  app.get('/runs/:id', asyncRoute(async (req, res) => { res.json(await service.get(res.locals.principal, req.params.id!)); }));
  app.post('/capabilities/:id/invoke', asyncRoute(async (req, res) => {
    const body = Invoke.parse(req.body);
    res.status(202).json(await service.invoke(res.locals.principal, req.params.id!, body.args, req.get('Idempotency-Key') ?? '', body.operator, body.lookupOnly ?? false));
  }));
  app.post('/runs/:id/decision', asyncRoute(async (req, res) => {
    const body = z.object({ approvalId: z.string().uuid(), decision: z.enum(['approve', 'retry', 'abort']) }).strict().parse(req.body);
    await service.decide(res.locals.principal, req.params.id!, body.approvalId, body.decision);
    res.json({ accepted: true });
  }));
  app.get('/runs/:id/evidence/:file', asyncRoute(async (req, res) => {
    const run = await service.get(res.locals.principal, req.params.id!);
    if (!run.evidence.includes(req.params.file!)) throw new RequestError(404, 'Unknown evidence file');
    res.sendFile(resolve(join(service.evidenceDir, req.params.id!, req.params.file!)));
  }));
  app.use('/conversations', conversationRouter(service, config.conversations));
  const chat = createChatHandlers(service, config.chatModel);
  app.get('/api/chat/request', chat.request);
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
  const journalDir = join(evidenceDir, 'journal');
  const journalKey = process.env.JOURNAL_HMAC_KEY ?? '';
  let journal: RunJournal | undefined;
  let uiDir: string | undefined;
  let service: InvocationService | undefined;
  let pool: Pool | undefined;
  let postgresJournal = false;
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = () => cleanupPromise ??= (async () => {
    let failure: unknown;
    try { await service?.close(); } catch (error) { failure = error; }
    // A runtime cleanup failure means the native close cannot be trusted. Keep
    // the PostgreSQL authority owner so a later process cannot admit a run.
    if (!postgresJournal || !service?.cleanupFailedState) {
      try { await journal?.close(); } catch (error) { failure ??= error; }
    }
    try { await pool?.end(); } catch (error) { failure ??= error; }
    if (uiDir) rmSync(uiDir, { recursive: true, force: true });
    if (failure) throw failure;
  })();
  try {
    const storage = resolveServerStorageConfiguration();
    const { subjectTokens, databaseUrl } = storage;
    postgresJournal = storage.mode === 'postgres';
    let conversations: ConversationStore | undefined;
    let shutdownOnDatabaseError: (() => void) | undefined;
    if (databaseUrl) {
      try {
        pool = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
        pool.on('error', () => { process.exitCode = 1; shutdownOnDatabaseError?.(); });
        if (storage.enableConversations) {
          conversations = new ConversationStore(pool);
          await conversations.migrate();
        }
      } catch { throw new Error('Conversation storage startup failed'); }
    }
    if (postgresJournal && !pool) throw new Error('PostgreSQL journal requires DATABASE_URL');
    try {
      journal = await openRunJournal(journalDir, journalKey, pool);
    } catch (error) {
      // Preserve the actionable local ownership error used by the lock gate;
      // all other opener failures stay deliberately generic at the HTTP entry.
      if (!postgresJournal && error instanceof Error && error.message === 'Journal already in use') throw error;
      throw new Error(postgresJournal ? 'Authoritative journal startup failed' : 'Journal startup failed');
    }
    // Snapshot the Next.js export so later builds cannot change a running instance.
    const sourceUi = resolve('out');
    if (!existsSync(join(sourceUi, 'index.html'))) throw new Error('Build the Next.js frontend first: npm run build');
    uiDir = mkdtempSync(join(tmpdir(), 'meridian-ui-'));
    cpSync(sourceUi, uiDir, { recursive: true });
    service = new InvocationService(journal, policy, profile, evidenceDir, (process.env.CALLER_CAPABILITIES ?? '').split(',').filter(Boolean), process.env.ARTIFACT_DIR ?? 'artifacts');
    const port = Number(process.env.PORT ?? 4180);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid PORT');
    const app = createApp(service, { callerToken: process.env.CALLER_API_TOKEN ?? '', operatorToken: process.env.OPERATOR_API_TOKEN ?? '', subjectTokens, conversations, port, uiDir,
      localTellerLogin: subjectTokens ? undefined : process.env.LOCAL_TELLER_LOGIN === '1' ? {
        teller: process.env.MERIDIAN_TELLER_OPERATOR ?? 'TELLER',
        supervisor: process.env.MERIDIAN_SUPERVISOR_OPERATOR ?? 'SUPERVISOR',
      } : undefined,
    });
    const server = app.listen(port, '127.0.0.1');
    await new Promise<void>((resolveListening, rejectListening) => {
      const listening = () => { server.removeListener('error', failed); resolveListening(); };
      const failed = (error: Error) => { server.removeListener('listening', listening); rejectListening(error); };
      server.once('listening', listening);
      server.once('error', failed);
    });
    console.log(`Dashboard: http://127.0.0.1:${port}`);
    let closing = false;
    const shutdown = () => {
      if (closing) return;
      closing = true;
      for (const signal of ['SIGINT', 'SIGTERM'] as const) process.removeListener(signal, shutdown);
      // Reject late model invocations before draining HTTP or awaiting runtime cleanup.
      void cleanup().catch(() => { process.exitCode = 1; });
      if (server.listening) server.close();
      server.closeAllConnections();
    };
    shutdownOnDatabaseError = shutdown;
    server.once('close', shutdown);
    server.on('error', () => { shutdown(); process.exitCode = 1; });
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, shutdown);
    return server;
  } catch (error) { await cleanup().catch(() => {}); throw error; }
}
