// Structured evidence for every run: a JSONL log (what happened and why),
// per-step screenshots, and a final result.json. Strict evidence uses fixed
// allowlists; legacy evidence passes through the Redactor.

import { appendFileSync, mkdirSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Redactor } from '../safety/redact.js';
import type { Observation, Surface } from '../surface/types.js';
import { safeEvent, safeResult } from './safe-event.js';

const STRUCTURAL_SELECTOR = /^body > [a-z][a-z0-9-]*:nth-of-type\([1-9]\d*\)(?: > [a-z][a-z0-9-]*:nth-of-type\([1-9]\d*\))*$/;
const STRUCTURAL_TAGS = new Set(['article', 'center', 'div', 'form', 'main', 'section', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr']);

function strictTableStructure(table: unknown): { selector: string; rows: number; rowCells: Array<Array<'td' | 'th'>> } | undefined {
  if (!table || typeof table !== 'object') return undefined;
  const candidate = table as Record<string, unknown>;
  if (typeof candidate.selector !== 'string' || !STRUCTURAL_SELECTOR.test(candidate.selector)
    || !candidate.selector.match(/[a-z][a-z0-9-]*(?=:nth-of-type\()/g)?.every(tag => STRUCTURAL_TAGS.has(tag))
    || !Number.isSafeInteger(candidate.rows) || (candidate.rows as number) < 0
    || !Array.isArray(candidate.rowCells) || candidate.rowCells.length !== candidate.rows
    || !candidate.rowCells.every(row => Array.isArray(row) && row.every(cell => cell === 'td' || cell === 'th'))) return undefined;
  return { selector: candidate.selector, rows: candidate.rows as number, rowCells: candidate.rowCells as Array<Array<'td' | 'th'>> };
}

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
    const safe = safeEvent(event, data);
    const approvalId = ['intervention.pending', 'intervention.decided'].includes(event) && typeof data.approvalId === 'string'
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(data.approvalId) ? { approvalId: data.approvalId } : {};
    const entry = this.strict
      ? { ...safe.data, ...approvalId, ts: new Date().toISOString(), seq: this.seq++, event: safe.event }
      : this.redactor.redact({ ...data, ts: new Date().toISOString(), seq: this.seq++, event });
    appendFileSync(join(this.dir, 'log.jsonl'), JSON.stringify(entry) + '\n', { mode: 0o600 });
    // Observers receive only typed metadata, after persistence. Their failures
    // cannot turn a completed browser action into a retryable execution error.
    try { void Promise.resolve(this.onEvent?.(safe.event, Object.freeze({ ...safe.data }))).catch(() => {}); } catch { /* optional observer */ }
  }

  /** `observation` lets a caller that just observed the page skip a second observe() (PF-M1). */
  async screenshot(surface: Surface, label: string, observation?: Observation): Promise<string> {
    const safeLabel = label.replace(/[^a-zA-Z0-9._-]/g, '_');
    const file = join(this.dir, `${String(this.seq).padStart(3, '0')}-${safeLabel}.png`);
    // Screenshots bypass text redaction by nature — hand the surface the
    // sensitive values so it can mask matching on-screen inputs for the shot.
    const values = this.redactor.maskValues();
    try {
      await surface.screenshot(file, values.length ? { maskValues: values } : {});
      if (existsSync(file)) chmodSync(file, 0o600);
      if (this.strict) {
        const observed = observation ?? await surface.observe();
        writeFileSync(file.replace(/\.png$/, '.json'), JSON.stringify({ frames: observed.frames.map(f => ({
          frame: f.frame,
          fields: f.fields,
          tables: (f.tables ?? []).map(strictTableStructure).filter(table => table !== undefined),
        })), note: 'Text omitted; sanitized control structure only' }), { mode: 0o600 });
      }
      return file;
    } catch {
      this.log('evidence.warning', { warning: 'Capture unavailable; metadata-only evidence' });
      return '(metadata-only evidence)';
    }
  }

  writeResult(result: unknown): void {
    const persisted = this.strict ? safeResult(result) : this.redactor.redact(result);
    writeFileSync(join(this.dir, 'result.json'), JSON.stringify(persisted, null, 2), { mode: 0o600 });
  }
}
