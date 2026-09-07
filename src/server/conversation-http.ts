import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { safeResult } from '../evidence/safe-event.js';
import { RequestError } from '../runtime/journal.js';
import { principalKey, type SubjectPrincipal } from './auth.js';
import { ConversationStore, type ConversationEvent } from './conversations.js';
import type { InvocationService } from './service.js';

const uuid = z.string().uuid().refine(value => value === value.toLowerCase());
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1);
const integerQuery = z.string().regex(/^(0|[1-9]\d*)$/).transform(Number);
const limitQuery = integerQuery.pipe(z.number().int().min(1).max(100)).default('50');
const createBody = z.object({ id: uuid }).strict();
const listQuery = z.object({
  archived: z.enum(['false', 'true']).transform(value => value === 'true').default('false'),
  after: uuid.optional(),
  limit: limitQuery,
}).strict();
const idParams = z.object({ id: uuid }).strict();
const archiveBody = z.object({ archived: z.boolean(), expectedRevision: revision }).strict();
const deleteBody = z.object({ expectedRevision: revision }).strict();
const appendBody = z.object({
  id: uuid,
  kind: z.enum(['message_omitted', 'run_linked']),
  role: z.enum(['user', 'assistant']),
  runId: uuid.optional(),
  expectedRevision: revision,
}).strict().superRefine((event, context) => {
  if ((event.kind === 'run_linked') !== (event.runId !== undefined))
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'runId does not match kind' });
});
const eventQuery = z.object({ after: integerQuery.default('0'), limit: limitQuery }).strict();

const asyncRoute = (handler: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => { void handler(req, res).catch(next); };

function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.output<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new RequestError(400, 'Conversation request does not match the contract');
  return parsed.data;
}

export function conversationRouter(service: InvocationService, store?: ConversationStore): Router {
  const router = Router();
  router.use((_req, res, next) => {
    if (typeof res.locals.principal === 'string') return next(new RequestError(403, 'Conversation access requires subject authentication'));
    if (!store) return next(new RequestError(503, 'Conversation storage is unavailable'));
    next();
  });

  const subject = (res: Response) => res.locals.principal as SubjectPrincipal;
  const projectRun = async (principal: SubjectPrincipal, runId: string) => {
    const record = await service.journal.get(runId);
    if (!record || record.caller !== principalKey(principal)) throw new RequestError(404, 'Unknown run');
    const run = await service.get(principal, runId);
    const result = run.result === undefined ? undefined : safeResult({
      ...(run.result && typeof run.result === 'object' ? run.result : {}),
      ...(run.structure === undefined ? {} : { structure: run.structure }),
    });
    return { runId: run.runId, capability: run.capability, version: run.version, state: run.state, result };
  };
  const projectEvent = async (principal: SubjectPrincipal, event: ConversationEvent) => ({
    ...event,
    content: event.kind === 'message_omitted' ? 'Message text was not saved.' : 'Linked run.',
    ...(event.runId === undefined ? {} : { run: await projectRun(principal, event.runId) }),
  });

  router.post('/', asyncRoute(async (req, res) => {
    const body = parse(createBody, req.body);
    res.status(201).json(await store!.create(subject(res).subjectId, body.id));
  }));
  router.get('/', asyncRoute(async (req, res) => {
    res.json(await store!.list(subject(res).subjectId, parse(listQuery, req.query)));
  }));
  router.get('/:id', asyncRoute(async (req, res) => {
    res.json(await store!.get(subject(res).subjectId, parse(idParams, req.params).id));
  }));
  router.patch('/:id', asyncRoute(async (req, res) => {
    const id = parse(idParams, req.params).id;
    const body = parse(archiveBody, req.body);
    res.json(await store!.archive(subject(res).subjectId, id, body.archived, body.expectedRevision));
  }));
  router.delete('/:id', asyncRoute(async (req, res) => {
    const id = parse(idParams, req.params).id;
    await store!.delete(subject(res).subjectId, id, parse(deleteBody, req.body).expectedRevision);
    res.status(204).end();
  }));
  router.post('/:id/events', asyncRoute(async (req, res) => {
    const principal = subject(res);
    const id = parse(idParams, req.params).id;
    const body = parse(appendBody, req.body);
    if (body.runId !== undefined) await projectRun(principal, body.runId);
    const event = await store!.append(principal.subjectId, id, body);
    res.status(201).json(await projectEvent(principal, event));
  }));
  router.get('/:id/events', asyncRoute(async (req, res) => {
    const principal = subject(res);
    const page = await store!.events(principal.subjectId, parse(idParams, req.params).id, parse(eventQuery, req.query));
    res.json({ ...page, events: await Promise.all(page.events.map(event => projectEvent(principal, event))) });
  }));
  return router;
}
