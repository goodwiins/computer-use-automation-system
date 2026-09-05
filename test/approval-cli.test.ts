import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestApproval, sanitizePendingApproval, startApprovalServer } from '../src/escalation/approval-cli.js';
import { OperatorConsole } from '../src/escalation/operator.js';
import { ControlSession } from '../src/escalation/session.js';
import { Approval, type ActionContext } from '../src/runtime/approval.js';

const dirs: string[] = [];
const TSX = 'tsx';
const childFixture = resolve('test/fixtures/approval-cli-child.ts');
const request = { kind: 'risk_approval' as const, capability: 'hold', goal: 'apply hold', reason: 'review current facts', url: 'https://example.test/review?token=hidden' };
const action = (runId: string): ActionContext => ({
  runId, artifact: 'hold', version: '1.0.0', stepId: 'post', destination: 'https://example.test/hold/post?token=destination-secret', method: 'POST',
  operator: 'OPR1', branch: 'MAIN', role: 'SUPERVISOR', facts: { member: '123', token: 'must-not-cross' }, tokenPresent: true, control: 'Apply Hold',
});

function temp(): string {
  const dir = mkdtempSync('/tmp/cu-ap-');
  dirs.push(dir);
  return dir;
}

function child(args: string[], tty = false): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise(resolveChild => {
    const argv = tty
      ? ['--import', TSX, childFixture, ...args]
      : ['--import', TSX, 'cli.ts', ...args];
    const childProcess = spawn(process.execPath, argv, { cwd: resolve('.'), env: processEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    childProcess.stdout.on('data', data => { stdout += data.toString(); });
    childProcess.stderr.on('data', data => { stderr += data.toString(); });
    childProcess.on('close', code => resolveChild({ code, stdout, stderr }));
  });
}

function processEnv(): NodeJS.ProcessEnv {
  return { ...process.env, CU_APPROVAL_DIR: process.env.CU_APPROVAL_DIR };
}

afterEach(() => {
  delete process.env.CU_APPROVAL_DIR;
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('standalone approval CLI transport', () => {
  it('shows facts and records exact approve/refuse commands from a second process', async () => {
    process.env.CU_APPROVAL_DIR = temp();
    const runId = randomUUID();
    const approval = new Approval(new ControlSession(), () => {}, Date.now() + 60_000);
    const pending = approval.wait(request, action(runId));
    const approvalId = approval.pending!.id;
    const server = await startApprovalServer(runId, approval);
    try {
      const shown = await child(['approval', '--run', runId]);
      expect(shown).toMatchObject({ code: 0, stderr: '' });
      expect(shown.stdout).toContain(`approval   : ${approvalId}`);
      expect(shown.stdout).toContain(`npx tsx cli.ts approve --run ${runId} --approval ${approvalId}`);
      expect(shown.stdout).toContain('"member":"123"');
      expect(shown.stdout).toContain('artifact   : hold@1.0.0');
      expect(shown.stdout).toContain('step       : post');
      expect(shown.stdout).toContain('operator   : OPR1');
      expect(shown.stdout).toContain('branch     : MAIN');
      expect(shown.stdout).toContain('role       : SUPERVISOR');
      expect(shown.stdout).toContain('control    : Apply Hold');
      expect(shown.stdout).toContain('token      : present');
      expect(shown.stdout).not.toContain('must-not-cross');
      expect(shown.stdout).not.toContain('destination-secret');

      const wrong = await child(['refuse', '--run', runId, '--approval', randomUUID()]);
      expect(wrong.code).toBe(1);
      expect(wrong.stderr).toContain('Stale or duplicate decision');
      expect(approval.pending?.id).toBe(approvalId);

      const piped = await child(['approve', '--run', runId, '--approval', approvalId]);
      expect(piped.code).toBe(1);
      expect(piped.stderr).toContain('approve requires an interactive terminal');
      expect(approval.pending?.id).toBe(approvalId);

      const approved = await child(['approve', '--run', runId, '--approval', approvalId], true);
      expect(approved).toMatchObject({ code: 0, stderr: '' });
      expect(approved.stdout).toContain('decision recorded');
      expect(approved.stdout).not.toContain('posted');
      expect(await pending).toBe('approve');
      const duplicate = await child(['refuse', '--run', runId, '--approval', approvalId]);
      expect(duplicate.code).toBe(1);
      expect(duplicate.stderr).toContain('Stale or duplicate decision');
    } finally { await server.close(); }

    const refusedApproval = new Approval(new ControlSession(), () => {}, Date.now() + 60_000);
    const refused = refusedApproval.wait(request, action(runId));
    const refusedId = refusedApproval.pending!.id;
    const refusedServer = await startApprovalServer(runId, refusedApproval);
    try {
      const refusal = await child(['refuse', '--run', runId, '--approval', refusedId]);
      expect(refusal).toMatchObject({ code: 0, stderr: '' });
      expect(refusal.stdout).toContain('run will abort');
      expect(await refused).toBe('abort');
    } finally { await refusedServer.close(); }

    const unavailable = await child(['refuse', '--run', runId, '--approval', approvalId]);
    expect(unavailable.code).toBe(1);
    expect(unavailable.stderr).toContain('Approval endpoint is unavailable');
  }, 15_000);

  it('uses the Approval state machine for first-decision-wins and drains the winner response during cleanup', async () => {
    process.env.CU_APPROVAL_DIR = temp();
    const runId = randomUUID();
    const approval = new Approval(new ControlSession(), () => {}, Date.now() + 60_000);
    const pending = approval.wait(request, action(runId));
    const approvalId = approval.pending!.id;
    const server = await startApprovalServer(runId, approval);
    const idle = createConnection(server.endpoint);
    await new Promise<void>((resolveConnect, reject) => { idle.once('connect', resolveConnect); idle.once('error', reject); });
    const idleClosed = new Promise<void>(resolveClose => idle.once('close', () => resolveClose()));

    const winner = requestApproval(runId, { action: 'decide', approvalId, decision: 'abort' });
    expect(await pending).toBe('abort');
    await server.close();
    await expect(winner).resolves.toEqual({ ok: true, decision: 'abort' });
    await idleClosed;
    expect(idle.destroyed).toBe(true);
    await expect(requestApproval(runId, { action: 'decide', approvalId, decision: 'approve' })).rejects.toThrow(/unavailable/);
  });

  it('R3-B1: sanitizePendingApproval strips query strings and sensitive fact keys but keeps the intervention shape', () => {
    const runId = randomUUID();
    const pending = { id: randomUUID(), expiresAt: Date.now() + 1000, request, action: action(runId) };
    const safe = sanitizePendingApproval(pending);
    expect(safe.id).toBe(pending.id);
    expect(safe.request.kind).toBe('risk_approval');
    expect(safe.request.url).toBe('https://example.test/review');
    expect(safe.action?.destination).toBe('https://example.test/hold/post');
    expect(safe.action?.facts).toEqual({ member: '123' });
    expect(JSON.stringify(safe)).not.toMatch(/hidden|destination-secret|must-not-cross/);
    expect(pending.action.facts.token).toBe('must-not-cross'); // input untouched
  });

  it('rejects malformed, oversized and insecure endpoints without consuming the approval', async () => {
    process.env.CU_APPROVAL_DIR = temp();
    const runId = randomUUID();
    const approval = new Approval(new ControlSession(), () => {}, Date.now() + 60_000);
    const pending = approval.wait(request, action(runId));
    const approvalId = approval.pending!.id;
    const server = await startApprovalServer(runId, approval);
    const raw = (body: Buffer) => new Promise<string>((resolveRaw, reject) => {
      const socket = createConnection(server.endpoint); const chunks: Buffer[] = [];
      socket.on('connect', () => socket.end(body));
      socket.on('data', chunk => chunks.push(chunk));
      socket.on('end', () => resolveRaw(Buffer.concat(chunks).toString('utf8')));
      socket.on('error', reject);
    });
    try {
      expect(await raw(Buffer.from('{'))).toContain('Malformed approval request');
      expect(await raw(Buffer.alloc(8 * 1024 + 1, 120))).toContain('Approval request is too large');
      expect(approval.pending?.id).toBe(approvalId);
      chmodSync(process.env.CU_APPROVAL_DIR, 0o755);
      await expect(requestApproval(runId, { action: 'decide', approvalId, decision: 'approve' })).rejects.toThrow(/owner-only/);
      expect(approval.pending?.id).toBe(approvalId);
    } finally {
      chmodSync(process.env.CU_APPROVAL_DIR, 0o700);
      approval.cancel();
      await pending;
      await server.close();
    }

    const real = temp(); const link = `/tmp/cu-ap-link-${randomUUID()}`; dirs.push(link);
    symlinkSync(real, link); process.env.CU_APPROVAL_DIR = link;
    await expect(startApprovalServer(randomUUID(), new Approval(new ControlSession(), () => {}, Date.now() + 1_000))).rejects.toThrow(/real directory/);

    const occupiedDir = temp(); process.env.CU_APPROVAL_DIR = occupiedDir;
    const occupiedRun = randomUUID(); const occupied = join(occupiedDir, `${occupiedRun}.sock`);
    writeFileSync(occupied, 'do not replace');
    await expect(startApprovalServer(occupiedRun, new Approval(new ControlSession(), () => {}, Date.now() + 1_000))).rejects.toThrow(/already exists/);
    expect(existsSync(occupied)).toBe(true);
  });

  it('bounds trickle and oversized clients by count and absolute lifetime', async () => {
    process.env.CU_APPROVAL_DIR = temp();
    const runId = randomUUID();
    const approval = new Approval(new ControlSession(), () => {}, Date.now() + 60_000);
    const pending = approval.wait(request, action(runId));
    const server = await startApprovalServer(runId, approval);
    const clients = Array.from({ length: 128 }, (_unused, index) => {
      const socket = createConnection(server.endpoint);
      if (index >= 64) socket.once('connect', () => socket.write(Buffer.alloc(8 * 1024 + 1, 120)));
      return socket;
    });
    const intervals = clients.map(socket => {
      socket.on('error', () => {});
      return setInterval(() => { if (!socket.destroyed) socket.write('{'); }, 250);
    });
    try {
      await new Promise(resolveWait => setTimeout(resolveWait, 3_600));
      expect(clients.every(socket => socket.destroyed)).toBe(true);
      expect(approval.pending).toBeDefined();
    } finally {
      for (const interval of intervals) clearInterval(interval);
      for (const socket of clients) socket.destroy();
      approval.cancel(); await pending; await server.close();
    }
  }, 10_000);

  it('cancels an interactive standalone approval when the browser closes', async () => {
    process.env.CU_APPROVAL_DIR = temp();
    const original = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    const callbacks = new Map<string, () => void>();
    const page = {
      isClosed: () => false,
      exposeBinding: async () => {}, frames: () => [],
      on: (event: string, callback: () => void) => { callbacks.set(event, callback); if (event === 'close') setTimeout(callback, 10); },
      off: (event: string) => callbacks.delete(event),
    };
    const session = new ControlSession();
    const logger = { runId: randomUUID(), log: vi.fn() };
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const result = await new OperatorConsole(page as never, logger as never, session).intervene(request, action(logger.runId));
      expect(result).toBe('abort');
      expect(session.currentOwner).toBe('automation');
      expect(logger.log).toHaveBeenCalledWith('intervention.decided', { decision: 'abort' });
      expect(consoleLog.mock.calls.flat().join(' ')).toContain('SUPERVISOR');
      expect(consoleLog.mock.calls.flat().join(' ')).not.toContain('destination-secret');
    } finally {
      consoleLog.mockRestore();
      if (original) Object.defineProperty(process.stdin, 'isTTY', original);
      else delete (process.stdin as { isTTY?: boolean }).isTTY;
    }
  });
});
