// Redaction for evidence logs. Two rules:
//  1. Values of parameters marked `sensitive` never appear in logs — masked
//     wherever they occur, including inside URLs and free text.
//  2. Anything that looks like a credential/token is masked defensively.
//
// Artifacts themselves never contain runtime values (params are stored as
// {{templates}}), so redaction only has to defend the evidence/log path.

const CREDENTIAL_RE =
  /\b(?:(?:sk|pk|key|token|secret|bearer)[-_]?[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|xox[bap]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35})\b/gi;
const MASK = '•••redacted•••';
/** Shorter sensitive values are matched as whole tokens, not as substrings. */
const MIN_SUBSTRING_LEN = 4;
const escapeRegexChars = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export class Redactor {
  private sensitiveValues: string[] = [];
  private protectedValues = new Set<string>();

  /** Register concrete runtime values that must never be logged. */
  addSensitiveValues(values: Array<string | number>, allowVisible = false): void {
    for (const v of values) {
      const s = String(v);
      if (s.length === 0) continue;
      if (!this.sensitiveValues.includes(s)) this.sensitiveValues.push(s);
      // Values surface URL-encoded in query strings and form bodies too.
      const enc = encodeURIComponent(s);
      if (!allowVisible) { this.protectedValues.add(s); this.protectedValues.add(enc); }
      if (enc !== s && !this.sensitiveValues.includes(enc)) this.sensitiveValues.push(enc);
    }
    this.sensitiveValues.sort((a, b) => b.length - a.length);
  }

  /** Exempt only corroborated business values registered as hidden, never credentials. */
  forVisibleValues(values: string[]): Redactor {
    const visible = new Set(values.flatMap(value => [value, encodeURIComponent(value)]));
    const redactor = new Redactor();
    redactor.addSensitiveValues(this.sensitiveValues.filter(value => !visible.has(value) || this.protectedValues.has(value)));
    return redactor;
  }

  /** Original string spans, merged so overlapping credentials cannot leave a suffix exposed. */
  private ranges(s: string): Array<[number, number]> {
    const patterns = [CREDENTIAL_RE, ...this.sensitiveValues.map(value => new RegExp(value.length >= MIN_SUBSTRING_LEN
      ? escapeRegexChars(value) : `(?<![A-Za-z0-9])${escapeRegexChars(value)}(?![A-Za-z0-9])`, 'g'))];
    const matches = patterns.flatMap(pattern => Array.from(s.matchAll(pattern), match => [match.index, match.index + match[0].length] as [number, number]))
      .sort((a, b) => a[0] - b[0]);
    const merged: Array<[number, number]> = [];
    for (const [start, end] of matches) {
      const previous = merged.at(-1);
      if (previous && start <= previous[1]) previous[1] = Math.max(previous[1], end);
      else merged.push([start, end]);
    }
    return merged;
  }

  redactString(s: string): string {
    let out = s.replace(CREDENTIAL_RE, MASK);
    for (const v of this.sensitiveValues) {
      // A short sensitive value (a member id of "1", an amount of "0") occurs
      // inside unrelated log text constantly, so substring-masking it shreds
      // the evidence trail. Below the threshold, match whole tokens only.
      if (v.length >= MIN_SUBSTRING_LEN) out = out.split(v).join(MASK);
      else out = out.replace(new RegExp(`(?<![A-Za-z0-9])${escapeRegexChars(v)}(?![A-Za-z0-9])`, 'g'), MASK);
    }
    return out;
  }

  /** Mask decoded secrets while retaining every original URL byte outside those spans. */
  redactUrlComponent(raw: string): string {
    const decoded = decodeURIComponent(raw);
    const positions: Array<[number, number]> = [];
    let offset = 0;
    for (const chunk of raw.match(/(?:%[0-9a-f]{2})+|[^%]+/gi) ?? []) {
      for (const character of decodeURIComponent(chunk)) {
        const end = offset + (chunk.startsWith('%') ? Buffer.byteLength(character, 'utf8') * 3 : character.length);
        for (let unit = 0; unit < character.length; unit++) positions.push([offset, end]);
        offset = end;
      }
    }
    for (const [start, end] of this.ranges(decoded).reverse()) {
      raw = raw.slice(0, positions[start]![0]) + encodeURIComponent(MASK) + raw.slice(positions[end - 1]![1]);
    }
    return raw;
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
