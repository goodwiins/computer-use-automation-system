// Structured evidence for every run: a JSONL log (what happened and why),
// per-step screenshots, and a final result.json. Everything written here
// passes through the Redactor first — evidence must be debuggable without
// leaking regulated data.

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
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
  ) {
    this.runId = `${kind}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    this.dir = join(baseDir, this.runId);
    mkdirSync(this.dir, { recursive: true });
  }

  log(event: string, data: Record<string, unknown> = {}): void {
    const entry = this.redactor.redact({ ts: new Date().toISOString(), seq: this.seq++, event, ...data });
    appendFileSync(join(this.dir, 'log.jsonl'), JSON.stringify(entry) + '\n');
  }

  async screenshot(surface: Surface, label: string): Promise<string> {
    const safeLabel = label.replace(/[^a-zA-Z0-9._-]/g, '_');
    const file = join(this.dir, `${String(this.seq).padStart(3, '0')}-${safeLabel}.png`);
    try {
      await surface.screenshot(file);
      return file;
    } catch {
      return '(screenshot failed)';
    }
  }

  writeResult(result: unknown): void {
    writeFileSync(join(this.dir, 'result.json'), JSON.stringify(this.redactor.redact(result), null, 2));
  }
}
