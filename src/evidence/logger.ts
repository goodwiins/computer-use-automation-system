// Structured evidence for every run: a JSONL log (what happened and why),
// per-step screenshots, and a final result.json. Everything written here
// passes through the Redactor first — evidence must be debuggable without
// leaking regulated data.

import { appendFileSync, mkdirSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Redactor } from '../safety/redact.js';
import type { Surface } from '../surface/types.js';

export class RunLogger {
  readonly runId: string;
  readonly dir: string;
  private seq = 0;

  constructor(
    kind: 'discovery' | 'replay',
    private readonly redactor: Redactor,
    baseDir = 'evidence/runs',
    readonly strict = false,
    runId?: string,
    private readonly onEvent?: (event: string, data: Record<string, unknown>) => void,
  ) {
    this.runId = runId ?? `${kind}-${randomUUID()}`;
    this.dir = join(baseDir, this.runId);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  log(event: string, data: Record<string, unknown> = {}): void {
    this.onEvent?.(event, data);
    if (this.strict) data = Object.fromEntries(Object.entries(data).filter(([key]) => ['stepId', 'action', 'risk', 'status', 'kind', 'ms', 'classification', 'detector', 'outcomeCode', 'code', 'isRetry', 'warning', 'approvalId', 'expiresAt', 'decision'].includes(key)));
    const entry = this.redactor.redact({ ts: new Date().toISOString(), seq: this.seq++, event, ...data });
    appendFileSync(join(this.dir, 'log.jsonl'), JSON.stringify(entry) + '\n', { mode: 0o600 });
  }

  async screenshot(surface: Surface, label: string): Promise<string> {
    const safeLabel = label.replace(/[^a-zA-Z0-9._-]/g, '_');
    const file = join(this.dir, `${String(this.seq).padStart(3, '0')}-${safeLabel}.png`);
    // Screenshots bypass text redaction by nature — hand the surface the
    // sensitive values so it can mask matching on-screen inputs for the shot.
    const values = this.redactor.maskValues();
    try {
      await surface.screenshot(file, values.length ? { maskValues: values } : {});
      if (existsSync(file)) chmodSync(file, 0o600);
      if (this.strict) {
        const observation = await surface.observe();
        writeFileSync(file.replace(/\.png$/, '.json'), JSON.stringify({ frames: observation.frames.map(f => ({ frame: f.frame, fields: f.fields })), note: 'Text omitted; sanitized control structure only' }), { mode: 0o600 });
      }
      return file;
    } catch {
      this.log('evidence.warning', { warning: 'Capture unavailable; metadata-only evidence' });
      return '(metadata-only evidence)';
    }
  }

  writeResult(result: unknown): void {
    if (this.strict) {
      const r = result as Record<string, unknown>;
      result = { status: r.status, outcomeCode: r.outcomeCode, sensitiveValuesUnavailable: true, failure: r.status === 'failure' ? { code: (r.failure as Record<string, unknown>)?.code ?? 'RUN_FAILED' } : undefined };
    }
    writeFileSync(join(this.dir, 'result.json'), JSON.stringify(this.redactor.redact(result), null, 2), { mode: 0o600 });
  }
}
