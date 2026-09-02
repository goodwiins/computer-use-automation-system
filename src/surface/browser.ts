// Playwright implementation of the Surface. Accessibility-first: observation
// is the aria snapshot of every frame (framesets are first-class citizens
// here), and locator resolution prefers role+name over structure.

import { chromium, type Browser, type Frame, type Locator, type Page } from 'playwright';
import type { TargetDescriptor, TargetStrategy } from '../artifact/schema.js';
import { originAllowed } from '../safety/policy.js';
import {
  TargetResolutionError,
  type Observation,
  type ResolutionReport,
  type Surface,
} from './types.js';

const DEFAULT_TIMEOUT = 10_000;

/** Escape a value for use inside a double-quoted CSS attribute selector. */
export const escapeAttrValue = (v: string) => v.replace(/["\\]/g, '\\$&');

export class BrowserSurface implements Surface {
  private browser!: Browser;
  page!: Page; // exposed for escalation handoff (human drives the same page)

  // When allowedOrigins is set, frames outside it are invisible to observation
  // and untouchable by locator resolution — a foreign iframe embedded in a
  // legacy page can neither be read nor clicked.
  constructor(private readonly opts: { headful?: boolean; allowedOrigins?: string[] } = {}) {}

  private frameInBounds(frame: Frame): boolean {
    const url = frame.url();
    // Only bare about:blank passes; about:srcdoc inherits its parent's origin,
    // so it is in bounds only when its parent frame is.
    if (url === 'about:blank') return true;
    if (url.startsWith('about:')) {
      const parent = frame.parentFrame();
      return parent ? this.frameInBounds(parent) : true;
    }
    return !this.opts.allowedOrigins || originAllowed(this.opts.allowedOrigins, url);
  }

  async start(entryUrl: string): Promise<void> {
    // CU_CDP_PORT exposes the live session over the Chrome DevTools Protocol.
    // This is the handoff seam: a human operator's console (here, a demo
    // script; in production, a remote co-browsing bridge) attaches to the
    // SAME browser session the automation is driving.
    const args = process.env.CU_CDP_PORT ? [`--remote-debugging-port=${process.env.CU_CDP_PORT}`] : [];
    this.browser = await chromium.launch({ headless: !this.opts.headful, args });
    this.page = await this.browser.newPage();
    await this.page.goto(entryUrl, { waitUntil: 'load' });
  }

  currentUrl(): string {
    // In a frameset the top URL never changes; report the working frame's URL
    // when it is more specific.
    const frames = this.page.frames().filter((f) => f !== this.page.mainFrame());
    const work = frames.find((f) => f.name() === 'workarea') ?? frames[0];
    return work && work.url() !== 'about:blank' ? work.url() : this.page.url();
  }

  frameUrls(): string[] {
    return this.page.frames().map((f) => f.url());
  }

  async observe(): Promise<Observation> {
    const frames: Observation['frames'] = [];
    for (const frame of this.page.frames()) {
      if (frame.url() === 'about:blank' || !this.frameInBounds(frame)) continue;
      try {
        const snapshot = await frame.locator('body').ariaSnapshot({ timeout: 3000 });
        const fields = await frame.evaluate(() =>
          Array.from(document.querySelectorAll('input, select, textarea'))
            .map((e) => ({
              name: e.getAttribute('name') ?? '',
              type: e instanceof HTMLInputElement ? e.type : e.tagName.toLowerCase(),
            }))
            .filter((f) => f.name),
        );
        frames.push({ frame: frame === this.page.mainFrame() ? '' : frame.name(), snapshot, fields });
      } catch {
        // Frameset parent pages have no body; skip silently.
      }
    }
    return { url: this.currentUrl(), title: await this.page.title(), frames };
  }

  async navigate(url: string): Promise<void> {
    await this.page.goto(url, { waitUntil: 'load' });
  }

  async click(target: TargetDescriptor, timeoutMs = DEFAULT_TIMEOUT): Promise<ResolutionReport> {
    const { locator, report } = await this.resolve(target, timeoutMs);
    // Legacy pages navigate on click; wait for the frame to settle.
    await Promise.all([
      locator.click({ timeout: timeoutMs }),
      this.page.waitForLoadState('load', { timeout: timeoutMs }).catch(() => {}),
    ]);
    return report;
  }

  async fill(target: TargetDescriptor, value: string, timeoutMs = DEFAULT_TIMEOUT): Promise<ResolutionReport> {
    const { locator, report } = await this.resolve(target, timeoutMs);
    await locator.fill(value, { timeout: timeoutMs });
    return report;
  }

  async select(target: TargetDescriptor, value: string, timeoutMs = DEFAULT_TIMEOUT): Promise<ResolutionReport> {
    const { locator, report } = await this.resolve(target, timeoutMs);
    await locator.selectOption({ label: value }, { timeout: timeoutMs }).catch(async () => {
      await locator.selectOption(value, { timeout: timeoutMs }); // fall back to value=
    });
    return report;
  }

  async readText(
    target: TargetDescriptor,
    timeoutMs = DEFAULT_TIMEOUT,
  ): Promise<{ text: string; report: ResolutionReport }> {
    const { locator, report } = await this.resolve(target, timeoutMs);
    const text = (await locator.innerText({ timeout: timeoutMs })).trim();
    return { text, report };
  }

  async isTextVisible(text: string, frame?: string): Promise<boolean> {
    for (const f of this.framesToSearch(frame)) {
      try {
        if (await f.getByText(text).first().isVisible({ timeout: 250 })) return true;
      } catch {
        /* frame may be navigating; treat as not visible */
      }
    }
    return false;
  }

  async screenshot(path: string, opts: { maskValues?: string[] } = {}): Promise<void> {
    const restore = await this.maskSensitiveInputs(opts.maskValues ?? []);
    try {
      await this.page.screenshot({ path, fullPage: true });
    } finally {
      await restore();
    }
  }

  /**
   * Render matching inputs as password fields for the duration of a
   * screenshot, so sensitive values never persist in evidence PNGs. Returns
   * an unmask function that restores the original state.
   */
  private async maskSensitiveInputs(maskValues: string[]): Promise<() => Promise<void>> {
    if (maskValues.length === 0) return async () => {};
    for (const frame of this.page.frames()) {
      await frame
        .evaluate((values: string[]) => {
          for (const el of Array.from(document.querySelectorAll('input'))) {
            if (!(values.includes(el.value))) continue;
            const input = el as HTMLInputElement & { dataset: Record<string, string> };
            input.dataset.cuMaskType = input.getAttribute('type') ?? '';
            input.setAttribute('type', 'password');
          }
        }, maskValues)
        .catch(() => {}); // frame may be navigating — nothing to mask there
    }
    return async () => {
      for (const frame of this.page.frames()) {
        await frame
          .evaluate(() => {
            for (const el of Array.from(document.querySelectorAll('input[data-cu-mask-type]'))) {
              const input = el as HTMLInputElement & { dataset: Record<string, string> };
              const origType = input.dataset.cuMaskType ?? '';
              if (origType === '') input.removeAttribute('type');
              else input.setAttribute('type', origType);
              delete input.dataset.cuMaskType;
            }
          })
          .catch(() => {});
      }
    };
  }

  async close(): Promise<void> {
    await this.browser?.close();
  }

  // ---------- Locator resolution (the determinism core) ----------

  private framesToSearch(frameName?: string): Frame[] {
    const all = this.page
      .frames()
      .filter((f) => f.url() !== 'about:blank' && this.frameInBounds(f));
    if (frameName === undefined) return all;
    if (frameName === '') return [this.page.mainFrame()].filter((f) => this.frameInBounds(f));
    return all.filter((f) => f.name() === frameName);
  }

  private buildLocator(frame: Frame, s: TargetStrategy): Locator {
    switch (s.kind) {
      case 'role':
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return frame.getByRole(s.role as any, { name: s.name, exact: true });
      case 'nameAttr':
        // A name containing " or \ would otherwise build an invalid selector,
        // whose count() throws and reads as "no matches" — silent drift.
        return frame.locator(`[name="${escapeAttrValue(s.name)}"]`);
      case 'text':
        return frame.getByText(s.text, { exact: s.exact });
      case 'css':
        return frame.locator(s.selector);
    }
  }

  /**
   * Try each strategy in order across the candidate frames. A strategy wins
   * only when it matches exactly one element (or `nth` is declared).
   * Ambiguity is a failure, never a guess — determinism over convenience.
   * Retries until timeout to absorb slow loads.
   */
  private async resolve(
    target: TargetDescriptor,
    timeoutMs: number,
  ): Promise<{ locator: Locator; report: ResolutionReport }> {
    const deadline = Date.now() + timeoutMs;
    let attempts: Array<{ kind: string; matches: number }> = [];
    do {
      attempts = [];
      for (let i = 0; i < target.strategies.length; i++) {
        const strategy = target.strategies[i]!;
        for (const frame of this.framesToSearch(target.frame)) {
          let locator = this.buildLocator(frame, strategy);
          let count = 0;
          try {
            count = await locator.count();
          } catch {
            count = 0;
          }
          attempts.push({ kind: strategy.kind, matches: count });
          if (count === 1 || (count > 1 && target.nth !== undefined)) {
            if (count > 1) locator = locator.nth(target.nth!);
            return { locator, report: { strategyUsed: i, kind: strategy.kind, matches: count } };
          }
        }
      }
      await this.page.waitForTimeout(250);
    } while (Date.now() < deadline);
    throw new TargetResolutionError(target, attempts);
  }

  // ---------- Descriptor derivation (used by the recorder) ----------

  /**
   * Resolve the element via the discovery-time hint, then derive a tiered,
   * replay-grade descriptor from the live element's own properties.
   */
  async describeTarget(hint: TargetDescriptor): Promise<TargetDescriptor> {
    const { locator } = await this.resolve(hint, DEFAULT_TIMEOUT);
    const info = await locator.evaluate((el) => {
      const e = el as HTMLElement;
      const tag = e.tagName.toLowerCase();
      const role =
        e.getAttribute('role') ??
        ({ a: 'link', button: 'button', select: 'combobox', textarea: 'textbox' } as Record<string, string>)[tag] ??
        (tag === 'input'
          ? { submit: 'button', button: 'button', checkbox: 'checkbox', radio: 'radio' }[
              (e as HTMLInputElement).type
            ] ?? 'textbox'
          : undefined);
      const accName =
        e.getAttribute('aria-label') ??
        (tag === 'input' && ['submit', 'button'].includes((e as HTMLInputElement).type)
          ? (e as HTMLInputElement).value
          : ['a', 'button'].includes(tag)
            ? (e.textContent ?? '').trim()
            : undefined);
      // Minimal structural path as the tier of last resort.
      let node: Element | null = e;
      const parts: string[] = [];
      while (node && node.tagName !== 'BODY' && parts.length < 5) {
        const parent: Element | null = node.parentElement;
        const idx = parent ? Array.from(parent.children).filter((c) => c.tagName === node!.tagName).indexOf(node) : 0;
        parts.unshift(`${node.tagName.toLowerCase()}:nth-of-type(${idx + 1})`);
        node = parent;
      }
      return {
        tag,
        role,
        accName: accName || undefined,
        nameAttr: e.getAttribute('name') ?? undefined,
        text: tag === 'a' ? (e.textContent ?? '').trim() || undefined : undefined,
        cssPath: parts.join(' > '),
      };
    });

    const strategies: TargetStrategy[] = [];
    if (info.role && info.accName) strategies.push({ kind: 'role', role: info.role, name: info.accName });
    if (info.nameAttr) strategies.push({ kind: 'nameAttr', name: info.nameAttr });
    if (info.text) strategies.push({ kind: 'text', text: info.text, exact: true });
    // A model-supplied semantic css hint (e.g. `tr:has(...)`) is more robust
    // than the derived positional nth-of-type path, so it outranks it —
    // inserted here, before the structural fallback. Dedupe if identical.
    const hintCss = hint.strategies.find((s): s is Extract<TargetStrategy, { kind: 'css' }> => s.kind === 'css');
    if (hintCss) strategies.push(hintCss);
    if (!hintCss || hintCss.selector !== info.cssPath) strategies.push({ kind: 'css', selector: info.cssPath });

    return {
      description: hint.description,
      frame: hint.frame,
      strategies,
      nth: hint.nth,
      snapshot: { tag: info.tag, role: info.role, text: info.text ?? info.accName },
    };
  }
}
