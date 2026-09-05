import { chmodSync, lstatSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import type { Approval, PendingIntervention } from '../runtime/approval.js';
import { RequestError } from '../runtime/journal.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_REQUEST_BYTES = 8 * 1024;
const MAX_RESPONSE_BYTES = 32 * 1024;
const SOCKET_TIMEOUT_MS = 3_000;
const MAX_CONNECTIONS = 16;
const MAX_SOCKET_PATH_BYTES = 103;

type ApprovalRequest =
  | { action: 'status'; runId: string }
  | { action: 'decide'; runId: string; approvalId: string; decision: 'approve' | 'abort' };

export type PublicPendingApproval = {
  approvalId: string;
  expiresAt: number;
  capability: string;
  goal: string;
  reason: string;
  url: string;
  action?: Omit<NonNullable<PendingIntervention['action']>, 'tokenPresent'> & { tokenPresent: boolean };
};

export type ApprovalResponse =
  | { ok: true; pending: PublicPendingApproval }
  | { ok: true; decision: 'approve' | 'abort' }
  | { ok: false; error: string };

export function requireUuid(value: unknown, flag: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new RequestError(400, `${flag} must be a UUID`);
  return value.toLowerCase();
}

function approvalDirectory(): string {
  return resolve(process.env.CU_APPROVAL_DIR ?? join(homedir(), '.cu-approvals'));
}

function validateDirectory(create: boolean): string {
  const directory = approvalDirectory();
  if (create) {
    try { mkdirSync(directory, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new RequestError(503, 'Cannot create the local approval directory');
    }
  }
  let stat;
  try { stat = lstatSync(directory); }
  catch { throw new RequestError(503, 'Local approval directory is unavailable'); }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new RequestError(503, 'Local approval directory must be a real directory');
  if (typeof process.getuid !== 'function' || stat.uid !== process.getuid()) throw new RequestError(503, 'Local approval directory must be owned by the current user');
  if ((stat.mode & 0o077) !== 0) throw new RequestError(503, 'Local approval directory permissions must be owner-only');
  return directory;
}

function socketPath(runId: string, createDirectory: boolean): string {
  const path = join(validateDirectory(createDirectory), `${requireUuid(runId, '--run')}.sock`);
  if (Buffer.byteLength(path) > MAX_SOCKET_PATH_BYTES) throw new RequestError(503, 'Local approval socket path is too long');
  return path;
}

function validateSocket(path: string): void {
  let stat;
  try { stat = lstatSync(path); }
  catch { throw new RequestError(503, 'Approval endpoint is unavailable'); }
  if (stat.isSymbolicLink() || !stat.isSocket()) throw new RequestError(503, 'Approval endpoint is invalid');
  if (typeof process.getuid !== 'function' || stat.uid !== process.getuid()) throw new RequestError(503, 'Approval endpoint must be owned by the current user');
  if ((stat.mode & 0o077) !== 0) throw new RequestError(503, 'Approval endpoint permissions must be owner-only');
}

export function describePendingApproval(pending: PendingIntervention | undefined): PublicPendingApproval {
  if (!pending || pending.request.kind !== 'risk_approval') throw new RequestError(409, 'No pending risk approval');
  const action = pending.action && {
    ...pending.action,
    destination: safeUrl(pending.action.destination),
    facts: Object.fromEntries(Object.entries(pending.action.facts).filter(([key]) => !/token|password|secret|cookie|authorization|body/i.test(key))),
  };
  return {
    approvalId: pending.id,
    expiresAt: pending.expiresAt,
    capability: pending.request.capability,
    goal: pending.request.goal,
    reason: pending.request.reason,
    url: safeUrl(pending.request.url),
    ...(action ? { action } : {}),
  };
}

function safeUrl(value: string): string {
  try { const parsed = new URL(value); return `${parsed.origin}${parsed.pathname}`; }
  catch { return '(unavailable)'; }
}

function parseRequest(raw: Buffer, runId: string): ApprovalRequest {
  let value: unknown;
  try { value = JSON.parse(raw.toString('utf8')); }
  catch { throw new RequestError(400, 'Malformed approval request'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RequestError(400, 'Malformed approval request');
  const request = value as Record<string, unknown>;
  if (request.action === 'status' && Object.keys(request).length === 2) {
    const requestedRun = requireUuid(request.runId, '--run');
    if (requestedRun !== runId) throw new RequestError(409, 'Run does not match approval endpoint');
    return { action: 'status', runId: requestedRun };
  }
  if (request.action === 'decide' && Object.keys(request).length === 4 && (request.decision === 'approve' || request.decision === 'abort')) {
    const requestedRun = requireUuid(request.runId, '--run');
    if (requestedRun !== runId) throw new RequestError(409, 'Run does not match approval endpoint');
    return { action: 'decide', runId: requestedRun, approvalId: requireUuid(request.approvalId, '--approval'), decision: request.decision };
  }
  throw new RequestError(400, 'Malformed approval request');
}

function safeError(error: unknown): string {
  return error instanceof RequestError ? error.message : 'Approval request failed';
}

function responseBody(response: ApprovalResponse): Buffer {
  let body = Buffer.from(`${JSON.stringify(response)}\n`);
  if (body.length > MAX_RESPONSE_BYTES) body = Buffer.from(`${JSON.stringify({ ok: false, error: 'Approval response is too large' })}\n`);
  return body;
}

export async function startApprovalServer(runIdValue: string, approval: Approval): Promise<{ endpoint: string; close: () => Promise<void> }> {
  const runId = requireUuid(runIdValue, '--run');
  const endpoint = socketPath(runId, true);
  try { lstatSync(endpoint); throw new RequestError(409, 'Approval endpoint already exists'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }

  const sockets = new Map<Socket, 'reading' | 'writing'>();
  const server = createServer(socket => {
    sockets.set(socket, 'reading');
    const chunks: Buffer[] = [];
    let length = 0;
    let handled = false;
    const lifetime = setTimeout(() => socket.destroy(), SOCKET_TIMEOUT_MS);
    const send = (response: ApprovalResponse) => {
      clearTimeout(lifetime);
      socket.setTimeout(0);
      sockets.set(socket, 'writing');
      socket.end(responseBody(response));
    };
    socket.setTimeout(SOCKET_TIMEOUT_MS, () => socket.destroy());
    socket.on('data', chunk => {
      if (handled) return;
      length += chunk.length;
      if (length > MAX_REQUEST_BYTES) {
        handled = true;
        send({ ok: false, error: 'Approval request is too large' });
      } else chunks.push(chunk);
    });
    socket.on('end', () => {
      if (handled) return;
      handled = true;
      let response: ApprovalResponse;
      try {
        const request = parseRequest(Buffer.concat(chunks), runId);
        if (request.action === 'status') response = { ok: true, pending: describePendingApproval(approval.pending) };
        else {
          approval.decide(request.approvalId, request.decision);
          response = { ok: true, decision: request.decision };
        }
      } catch (error) { response = { ok: false, error: safeError(error) }; }
      send(response);
    });
    socket.on('close', () => { clearTimeout(lifetime); sockets.delete(socket); });
    socket.on('error', () => {});
  });
  server.maxConnections = MAX_CONNECTIONS;

  try {
    await new Promise<void>((resolveListen, reject) => {
      server.once('error', reject);
      server.listen(endpoint, () => { server.off('error', reject); resolveListen(); });
    });
    const created = lstatSync(endpoint);
    if (!created.isSocket() || typeof process.getuid !== 'function' || created.uid !== process.getuid()) throw new Error('invalid socket');
    chmodSync(endpoint, 0o600);
    validateSocket(endpoint);
  } catch (error) {
    await closeServer(server, sockets);
    if (error instanceof RequestError) throw error;
    throw new RequestError(503, 'Cannot start the local approval endpoint');
  }

  return { endpoint, close: () => closeServer(server, sockets) };
}

async function closeServer(server: Server, sockets: Map<Socket, 'reading' | 'writing'>): Promise<void> {
  for (const [socket, state] of sockets) if (state === 'reading') socket.destroy();
  if (server.listening) {
    await new Promise<void>(resolveClose => {
      const force = setTimeout(() => { for (const socket of sockets.keys()) socket.destroy(); }, SOCKET_TIMEOUT_MS);
      server.close(() => { clearTimeout(force); resolveClose(); });
    });
  }
}

export async function requestApproval(runIdValue: string, request: { action: 'status' } | {
  action: 'decide'; approvalId: string; decision: 'approve' | 'abort';
}): Promise<ApprovalResponse> {
  const runId = requireUuid(runIdValue, '--run');
  const endpoint = socketPath(runId, false);
  validateSocket(endpoint);
  const payload = Buffer.from(JSON.stringify({ ...request, runId }));
  if (payload.length > MAX_REQUEST_BYTES) throw new RequestError(400, 'Approval request is too large');

  return new Promise<ApprovalResponse>((resolveResponse, reject) => {
    const socket = createConnection(endpoint);
    const chunks: Buffer[] = [];
    let length = 0;
    let settled = false;
    const fail = (error: RequestError) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };
    socket.setTimeout(SOCKET_TIMEOUT_MS, () => fail(new RequestError(503, 'Approval endpoint timed out')));
    socket.on('connect', () => socket.end(payload));
    socket.on('data', chunk => {
      length += chunk.length;
      if (length > MAX_RESPONSE_BYTES) fail(new RequestError(503, 'Approval response is too large'));
      else chunks.push(chunk);
    });
    socket.on('error', () => fail(new RequestError(503, 'Approval endpoint is unavailable')));
    socket.on('end', () => {
      if (settled) return;
      let response: ApprovalResponse;
      try { response = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ApprovalResponse; }
      catch { return fail(new RequestError(503, 'Approval endpoint returned a malformed response')); }
      if (!response || typeof response !== 'object' || typeof response.ok !== 'boolean') return fail(new RequestError(503, 'Approval endpoint returned a malformed response'));
      if (response.ok && request.action === 'status' && !('pending' in response)) return fail(new RequestError(503, 'Approval endpoint returned a malformed response'));
      if (response.ok && request.action === 'decide' && (!('decision' in response) || response.decision !== request.decision)) return fail(new RequestError(503, 'Approval endpoint returned a malformed response'));
      if (!response.ok && typeof response.error !== 'string') return fail(new RequestError(503, 'Approval endpoint returned a malformed response'));
      settled = true;
      if (!response.ok) reject(new RequestError(409, response.error));
      else resolveResponse(response);
    });
  });
}
