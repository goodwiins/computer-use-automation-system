import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { safeResult } from '../evidence/safe-event.js';
import { MAX_RUN_BATCH, RequestError } from '../runtime/journal.js';
import { principalKey, type SubjectPrincipal } from './auth.js';
import { ConversationStore, type ConversationEvent } from './conversations.js';
import type { InvocationService } from './service.js';

const uuid = z.string().uuid().refine(value => value === value.toLowerCase());
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1);
const integerQuery = z.string().regex(/^(0|[1-9]\d*)$/).transform(Number);
const limitQuery = integerQuery.pipe(z.number().int().min(1).max(MAX_RUN_BATCH)).default('50');
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
  const projectingSubjects = new Set<string>();
  router.use((_req, res, next) => {
    if (typeof res.locals.principal === 'string') return next(new RequestError(403, 'Conversation access requires subject authentication'));
    if (!store) return next(new RequestError(503, 'Conversation storage is unavailable'));
    next();
  });

  const subject = (res: Response) => res.locals.principal as SubjectPrincipal;
  const withProjectionCapacity = async <T>(principal: SubjectPrincipal, work: () => Promise<T>): Promise<T> => {
    const owner = principalKey(principal);
    if (projectingSubjects.has(owner)) throw new RequestError(429, 'Linked-run projection is busy');
    projectingSubjects.add(owner);
    try { return await work(); }
    finally { projectingSubjects.delete(owner); }
  };
  const projectRun = (run: Awaited<ReturnType<InvocationService['get']>>) => {
    const result = run.result === undefined ? undefined : safeResult({
      ...(run.result && typeof run.result === 'object' ? run.result : {}),
      ...(run.structure === undefined ? {} : { structure: run.structure }),
    });
    return { runId: run.runId, capability: run.capability, version: run.version, state: run.state, result };
  };
  type ProjectedRun = ReturnType<typeof projectRun>;
  const projectRuns = async (principal: SubjectPrincipal, runIds: string[]): Promise<Map<string, ProjectedRun>> => {
    if (runIds.length === 0) return new Map();
    return withProjectionCapacity(principal, async () => {
      const owned = await service.getOwnedMany(principal, runIds);
      return new Map([...owned].map(([runId, run]) => [runId, projectRun(run)]));
    });
  };
  const projectEvent = (event: ConversationEvent, runs: Map<string, ProjectedRun>) => {
    const run = event.runId === undefined ? undefined : runs.get(event.runId);
    if (event.runId !== undefined && run === undefined) throw new RequestError(404, 'Unknown run');
    return {
      ...event,
      content: event.kind === 'message_omitted' ? 'Message text was not saved.' : 'Linked run.',
      ...(run === undefined ? {} : { run }),
    };
  };
  const projectEvents = async (principal: SubjectPrincipal, events: ConversationEvent[]) => {
    const runIds = [...new Set(events.flatMap(event => event.runId === undefined ? [] : [event.runId]))];
    const runs = await projectRuns(principal, runIds);
    return events.map(event => projectEvent(event, runs));
  };

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
    const runs = await projectRuns(principal, body.runId === undefined ? [] : [body.runId]);
    const event = await store!.append(principal.subjectId, id, body);
    res.status(201).json(projectEvent(event, runs));
  }));
  router.get('/:id/events', asyncRoute(async (req, res) => {
    const principal = subject(res);
    const page = await store!.events(principal.subjectId, parse(idParams, req.params).id, parse(eventQuery, req.query));
    res.json({ ...page, events: await projectEvents(principal, page.events) });
  }));
  return router;
}
