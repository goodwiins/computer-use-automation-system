// Redaction for evidence logs. Two rules:
//  1. Values of parameters marked `sensitive` never appear in logs — masked
//     wherever they occur, including inside URLs and free text.
//  2. Anything that looks like a credential/token is masked defensively.
//
// Artifacts themselves never contain runtime values (params are stored as
// {{templates}}), so redaction only has to defend the evidence/log path.

const CREDENTIAL_RE = /\b(?:sk|pk|key|token|secret|bearer)[-_]?[A-Za-z0-9]{16,}\b/gi;
const MASK = '•••redacted•••';

export class Redactor {
  private sensitiveValues: string[] = [];

  /** Register concrete runtime values that must never be logged. */
  addSensitiveValues(values: Array<string | number>): void {
    for (const v of values) {
      const s = String(v);
      if (s.length > 0) this.sensitiveValues.push(s);
    }
  }

  redactString(s: string): string {
    let out = s.replace(CREDENTIAL_RE, MASK);
    for (const v of this.sensitiveValues) out = out.split(v).join(MASK);
    return out;
  }

  /** Concrete values registered for masking (e.g. for screenshot input masking). */
  maskValues(): string[] {
    return [...this.sensitiveValues];
  }

  /** Deep-redact any JSON-serializable value. */
  redact<T>(value: T): T {
    if (typeof value === 'string') return this.redactString(value) as T;
    if (Array.isArray(value)) return value.map((v) => this.redact(v)) as T;
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = this.redact(v);
      return out as T;
    }
    return value;
  }
}
