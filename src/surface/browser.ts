// Playwright implementation of the Surface. Accessibility-first: observation
// is the aria snapshot of every frame (framesets are first-class citizens
// here), and locator resolution prefers role+name over structure.

import { chromium, type Browser, type BrowserContext, type Frame, type Locator, type Page, type Route } from 'playwright';
import type { TargetDescriptor, TargetStrategy, RiskClass, TableColumn } from '../artifact/schema.js';
import type { FrameContext, LiveControl, AppProfile, FaultScenario } from '../runtime/profile.js';
import { originAllowed } from '../safety/policy.js';
import {
  TargetResolutionError,
  type Observation,
  type ReadOnlyPageSnapshot,
  type ReadOnlyTableRequest,
  type ResolutionReport,
  type Surface,
} from './types.js';

const DEFAULT_TIMEOUT = 10_000;

/** Time left before `deadline`, floored so a retry always gets a real attempt. */
export const remainingMs = (deadline: number, floor = 500) => Math.max(floor, deadline - Date.now());

const timeoutRemaining = (deadline: number) => {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('Action timeout expired');
  return Math.max(1, remaining);
};

const explicitTimeout = (timeoutMs: number | undefined, deadline: number) => {
  if (timeoutMs === undefined) return timeoutRemaining(deadline);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Action timeout expired');
  return Math.max(1, timeoutMs);
};

const sameFrameContext = (left: FrameContext | undefined, right: FrameContext | undefined) => !!left && !!right
  && left.id === right.id && left.name === right.name && left.url === right.url && left.navigation === right.navigation;

/** Escape a value for use inside a double-quoted CSS attribute selector. */
export const escapeAttrValue = (v: string) => v.replace(/["\\]/g, '\\$&');

export class BrowserSurface implements Surface {
  private browser!: Browser;
  private context!: BrowserContext;
  page!: Page; // exposed for escalation handoff (human drives the same page)
  private faultInjected = false;
  private submission?: { url: string; method: string; body: string };
  private identity?: TargetIdentity;
  private dialogs: Array<{ type: string; message: string }> = [];
  private readonly frameIds = new WeakMap<Frame, string>();
  private readonly frameNavigations = new WeakMap<Frame, number>();
  private frameSequence = 0;
  private lastFrameContext?: FrameContext;

  // When allowedOrigins is set, frames outside it are invisible to observation
  // and untouchable by locator resolution — a foreign iframe embedded in a
  // legacy page can neither be read nor clicked.
  constructor(private readonly opts: { headful?: boolean; allowedOrigins?: string[]; profile?: AppProfile; fault?: FaultScenario; onClose?: () => void; sensitive?: (values: string[], secrets?: string[]) => void } = {}) {}

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

  private trackFrame(frame: Frame): void {
    if (!this.frameIds.has(frame)) this.frameIds.set(frame, `frame-${++this.frameSequence}`);
    if (!this.frameNavigations.has(frame)) this.frameNavigations.set(frame, 0);
  }

  private bumpFrame(frame: Frame): void {
    this.trackFrame(frame);
    this.frameNavigations.set(frame, (this.frameNavigations.get(frame) ?? 0) + 1);
  }

  private frameContext(frame: Frame): FrameContext {
    this.trackFrame(frame);
    return {
      id: this.frameIds.get(frame)!,
      name: frame.name(),
      url: frame.url(),
      navigation: this.frameNavigations.get(frame)!,
    };
  }

  private workingFrame(page = this.page): Frame | undefined {
    if (!page) return undefined;
    const main = page.mainFrame();
    const frames = page.frames().filter(frame => frame !== main);
    const work = frames.find(frame => frame.name() === 'workarea') ?? frames[0];
    return work && work.url() !== 'about:blank' ? work : main;
  }

  async start(entryUrl: string): Promise<void> {
    // CU_CDP_PORT exposes the live session over the Chrome DevTools Protocol.
    // This is the handoff seam: a human operator's console (here, a demo
    // script; in production, a remote co-browsing bridge) attaches to the
    // SAME browser session the automation is driving.
    //
    // ponytail: the seam is an UNAUTHENTICATED localhost control channel —
    // anything that can reach the port drives the session. Validating the
    // port only keeps arbitrary flags out of chromium's argv; a real
    // deployment fronts CDP with an authenticated co-browsing bridge.
    const port = process.env.CU_CDP_PORT;
    if (port && this.opts.profile?.appId === 'meridian') throw new Error('Remote CDP is not enabled for MERIDIAN');
    const args: string[] = [];
    if (port) {
      const n = Number(port);
      if (!Number.isInteger(n) || n < 1024 || n > 65535) {
        throw new Error(`CU_CDP_PORT must be an integer between 1024 and 65535 (got "${port}")`);
      }
      args.push(`--remote-debugging-port=${n}`);
    }
    this.browser = await chromium.launch({ headless: !this.opts.headful, args });
    this.context = await this.browser.newContext(this.opts.profile?.appId === 'meridian' ? { serviceWorkers: 'block' } : {});
    if (this.opts.profile?.appId === 'meridian') await this.context.routeWebSocket(/.*/, async socket => {
      await socket.close({ code: 1008, reason: 'WebSocket transport is disabled for MERIDIAN' });
    });
    this.page = await this.context.newPage();
    this.trackFrame(this.page.mainFrame());
    this.page.on('frameattached', frame => this.trackFrame(frame));
    this.page.on('framenavigated', frame => this.bumpFrame(frame));
    this.page.on('framedetached', frame => this.bumpFrame(frame));
    this.page.on('close', () => this.opts.onClose?.());
    if (this.opts.profile) await this.page.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (!originAllowed(this.opts.allowedOrigins ?? [], url.href)) return route.abort();
      if (!['GET', 'HEAD'].includes(request.method())) {
        const allowed = this.submission?.url === url.href && this.submission.method === request.method()
          && request.headers()['content-type']?.split(';')[0] === 'application/x-www-form-urlencoded'
          && this.submission.body === canonicalForm(new URLSearchParams(request.postData() ?? ''));
        this.submission = undefined;
        return allowed ? route.continue() : route.abort();
      }
      if (request.isNavigationRequest() && (!this.opts.profile!.routes?.some(p => new RegExp(p).test(url.pathname)) || /\/(post|review)$/.test(url.pathname))) return route.abort();
      if (!this.faultInjected && this.opts.fault && request.isNavigationRequest() && url.pathname === this.opts.fault.path) {
        this.faultInjected = true; url.searchParams.set('inject', this.opts.fault.kind);
        return route.continue({ url: url.href });
      }
      return route.continue();
    });
    // An unexpected native dialog is never answered "yes" by automation:
    // dismiss (the conservative branch), remember it, and let the executor
    // explain the step that failed because of it.
    this.page.on('dialog', (d) => {
      this.dialogs.push({ type: d.type(), message: d.message() });
      d.dismiss().catch(() => {});
    });
    await this.page.goto(entryUrl, { waitUntil: 'load' });
    await this.verifySignon();
  }

  drainDialogs(): Array<{ type: string; message: string }> {
    return this.dialogs.splice(0);
  }

  currentUrl(): string {
    // In a frameset the top URL never changes; report the working frame's URL
    // when it is more specific.
    const work = this.workingFrame();
    return work && work.url() !== 'about:blank' ? work.url() : this.page.url();
  }

  currentFrame(): FrameContext | undefined {
    const frame = this.workingFrame();
    return frame ? this.frameContext(frame) : undefined;
  }

  lastResolvedFrame(): FrameContext | undefined {
    return this.lastFrameContext ? { ...this.lastFrameContext } : undefined;
  }

  frameUrls(): string[] {
    return this.page.frames().map((f) => f.url());
  }

  async observe(): Promise<Observation> {
    await this.collectSensitive();
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
        const tables = await frame.evaluate(() => Array.from(document.querySelectorAll('table')).filter(table => !table.querySelector('table')).map(table => {
          const parts: string[] = [];
          let node: Element | null = table;
          while (node && node.tagName !== 'BODY') {
            const parent: Element | null = node.parentElement;
            const index = parent ? Array.from(parent.children).filter(child => child.tagName === node!.tagName).indexOf(node) + 1 : 1;
            parts.unshift(`${node.tagName.toLowerCase()}:nth-of-type(${index})`);
            node = parent;
          }
          const rowCells = Array.from(table.rows, row => Array.from(row.cells, cell => cell.tagName.toLowerCase() as 'td' | 'th'));
          return { selector: `body > ${parts.join(' > ')}`, headers: Array.from(table.rows[0]?.cells ?? [], cell => (cell.textContent ?? '').trim().slice(0, 100)), headerCells: rowCells[0] ?? [], rows: table.rows.length, rowCells };
        }));
        frames.push({ frame: frame === this.page.mainFrame() ? '' : frame.name(), snapshot, fields, tables });
      } catch {
        // Frameset parent pages have no body; skip silently.
      }
    }
    return { url: this.currentUrl(), title: await this.page.title(), frames };
  }

  async navigate(url: string): Promise<void> {
    await this.page.goto(url, { waitUntil: 'load' });
    await this.verifySignon();
  }

  async click(target: TargetDescriptor, timeoutMs = DEFAULT_TIMEOUT): Promise<ResolutionReport> {
    const deadline = Date.now() + timeoutMs;
    const { locator, report } = await this.resolve(target, timeoutMs);
    const actionTimeout = timeoutRemaining(deadline);
    // Legacy pages navigate on click; wait for the frame to settle.
    await Promise.all([
      locator.click({ timeout: actionTimeout }),
      this.page.waitForLoadState('load', { timeout: actionTimeout }).catch(() => {}),
    ]);
    return report;
  }

  async fill(target: TargetDescriptor, value: string, timeoutMs = DEFAULT_TIMEOUT): Promise<ResolutionReport> {
    const { locator, report } = await this.resolve(target, timeoutMs);
    await locator.fill(value, { timeout: timeoutMs });
    return report;
  }

  async select(target: TargetDescriptor, value: string, timeoutMs = DEFAULT_TIMEOUT, _risk?: RiskClass, selectBy?: 'label' | 'value'): Promise<ResolutionReport> {
    const deadline = Date.now() + timeoutMs;
    const { locator, report } = await this.resolve(target, timeoutMs);
    if (selectBy === 'value') {
      if (await locator.evaluate((e, selected) => [...(e as HTMLSelectElement).options].filter(o => o.value === selected).length, value) !== 1) throw new Error('Share or option value is missing or ambiguous');
      await locator.selectOption({ value }, { timeout: timeoutMs });
      return report;
    }
    await locator.selectOption({ label: value }, { timeout: timeoutMs }).catch(async () => {
      // Fall back to value= on whatever budget is left, so a label miss costs
      // one timeout, not two.
      await locator.selectOption(value, { timeout: remainingMs(deadline) });
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
        if (await f.getByText(text).filter({ visible: true }).first().isVisible({ timeout: 250 })) return true;
      } catch {
        /* frame may be navigating; treat as not visible */
      }
    }
    return false;
  }

  async screenshot(path: string, opts: { maskValues?: string[] } = {}): Promise<void> {
    if (this.opts.profile) {
      await this.collectSensitive();
      const profile = this.opts.profile;
      if (!profile.routes?.some(pattern => new RegExp(pattern).test(new URL(this.currentUrl()).pathname))) throw new Error('Unknown page: metadata-only evidence');
      const requiredMask = profile.maskSelectors?.[0];
      if (!requiredMask || await this.page.locator(requiredMask).count() !== 1) throw new Error('Unknown page structure: metadata-only evidence');
      // Whole content cells include dynamically observed financial/contact data.
      const masks = this.page.frames().flatMap(frame => (profile.maskSelectors ?? ['body']).map(selector => frame.locator(selector)));
      for (const frame of this.page.frames()) for (const value of opts.maskValues ?? []) masks.push(frame.getByText(value, { exact: false }));
      await this.page.screenshot({ path, fullPage: true, mask: masks });
      return;
    }
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

  async collectSensitive(): Promise<void> {
    if (!this.opts.profile || !this.page) return;
    for (const frame of this.page.frames()) {
      const observed = await frame.evaluate(() => {
        const result: string[] = [];
        const secrets: string[] = [];
        for (const e of document.querySelectorAll('input, textarea, select')) {
          const input = e as HTMLInputElement;
          if (input.type !== 'submit' && input.value) result.push(input.value);
          if (['password', 'hidden'].includes(input.type) && input.value) secrets.push(input.value);
        }
        for (const e of document.querySelectorAll('td.lbl + td, .box td, table[border="1"] td')) {
          if (e.textContent?.trim()) result.push(e.textContent.trim());
        }
        const sid = document.body.innerText.match(/SID\s+(\S+)/)?.[1];
        if (sid) { result.push(sid); secrets.push(sid); }
        return { values: result, secrets };
      });
      this.opts.sensitive?.(observed.values, observed.secrets);
    }
  }

  async readTable(target: TargetDescriptor, columns: TableColumn[], timeoutMs = DEFAULT_TIMEOUT, rowSelector?: string) {
    const { locator } = await this.resolve(target, timeoutMs);
    return this.extractTable(locator, columns, rowSelector);
  }

  private async extractTable(locator: Locator, columns: TableColumn[], rowSelector?: string) {
    const rows = await locator.evaluate((table, { cols, rows }) => [...table.querySelectorAll(rows ?? 'tr')]
      .filter(row => row.querySelector('td') && !row.querySelector('th'))
      .map(row => Object.fromEntries(cols.map(col => {
        const cells = row.querySelectorAll(col.selector);
        if (cells.length !== 1) throw new Error('Ambiguous table column');
        let value = (cells[0]!.textContent ?? '').trim();
        if (col.type === 'money') {
          value = value.replace(/[$,]/g, '');
          if (!/^-?(0|[1-9]\d*)\.\d{2}$/.test(value)) throw new Error('Invalid money column');
        }
        return [col.name, value];
      }))), { cols: columns, rows: rowSelector });
    this.opts.sensitive?.(rows.flatMap(row => columns.filter(c => this.opts.profile?.appId === 'meridian' || c.sensitive).map(c => row[c.name]!)));
    return rows;
  }

  async readOnlyPage(url: string, tables: ReadOnlyTableRequest[], timeoutMs = DEFAULT_TIMEOUT): Promise<ReadOnlyPageSnapshot> {
    if (!this.context || !this.page) throw new Error('Read-only page requires an active browser session');
    const expected = new URL(url);
    if (!/^\/members\/\d+$/.test(expected.pathname)) throw new Error('Read-only page must be an exact member page');
    if (!originAllowed(this.opts.allowedOrigins ?? [], expected.href)) throw new Error('Read-only page origin is not allowed');
    const deadline = Date.now() + timeoutMs;
    const remaining = () => timeoutRemaining(deadline);
    const page = await this.context.newPage();
    let violation: string | undefined;
    let navigation = 0;
    let navigationRequests = 0;
    let stableNavigation: number | undefined;
    let stableFrames: string | undefined;
    const unexpectedPages = new Set<Page>();
    const fail = (message: string) => { violation ??= message; };
    const closeUnexpectedPage = (opened: Page) => {
      if (opened === page || opened === this.page) return;
      fail('Read-only page opened a popup');
      unexpectedPages.add(opened);
      opened.close().catch(() => {});
    };
    this.context.on('page', closeUnexpectedPage);
    page.on('framenavigated', () => { navigation++; });
    page.on('dialog', dialog => {
      fail('Read-only page opened a dialog');
      dialog.dismiss().catch(() => {});
    });
    page.on('popup', popup => {
      fail('Read-only page opened a popup');
      popup.close().catch(() => {});
    });
    page.on('download', download => {
      fail('Read-only page started a download');
      download.cancel().catch(() => {});
    });
    const routeReadOnlyRequest = async (route: Route) => {
      const request = route.request();
      let requestPage: Page | undefined;
      try { requestPage = request.frame().page(); } catch { /* fail below */ }
      if (requestPage === this.page) return route.fallback();
      if (requestPage !== page) {
        fail('Read-only page opened a popup');
        if (requestPage) {
          unexpectedPages.add(requestPage);
          requestPage.close().catch(() => {});
        }
        return route.abort();
      }
      let requested: URL;
      try { requested = new URL(request.url()); }
      catch {
        fail('Read-only page requested an invalid URL');
        return route.abort();
      }
      if (requested.origin !== expected.origin || !['GET', 'HEAD'].includes(request.method())) {
        fail('Read-only page attempted an out-of-bounds request');
        return route.abort();
      }
      if (request.isNavigationRequest()) {
        if (request.frame() !== page.mainFrame() || request.method() !== 'GET' || requested.href !== expected.href) {
          fail('Read-only page attempted another navigation');
          return route.abort();
        }
        navigationRequests++;
        if (navigationRequests > 1) {
          fail('Read-only page changed during eligibility extraction');
          return route.abort();
        }
      }
      return route.continue();
    };
    const frameSignature = () => page.frames().map(frame => `${this.frameContext(frame).id}:${frame.url()}`).join('\n');
    const assertStable = () => {
      if (violation) throw new Error(violation);
      if (stableNavigation !== undefined && (navigation !== stableNavigation || frameSignature() !== stableFrames)) {
        throw new Error('Read-only page changed during eligibility extraction');
      }
    };
    let pendingError: unknown;
    try {
      await this.context.route('**/*', routeReadOnlyRequest);
      if (this.opts.profile?.appId === 'meridian') {
        // MERIDIAN member facts are server-rendered. Disable page-authored JS
        // only in this auxiliary tab so dedicated workers and popup scripts
        // cannot create transports that Playwright's WebSocket route misses.
        const scriptGuard = await this.context.newCDPSession(page);
        await scriptGuard.send('Emulation.setScriptExecutionDisabled', { value: true });
      }
      await page.goto(expected.href, { waitUntil: 'load', timeout: remaining() });
      if (violation) throw new Error(violation);
      const work = this.workingFrame(page);
      if (!work) throw new Error('Read-only page has no working frame');
      const resolved = new URL(work.url());
      if (resolved.origin !== expected.origin || resolved.pathname !== expected.pathname || resolved.search !== expected.search) {
        throw new Error('Read-only page redirected away from the bound member');
      }
      const frameUrls = page.frames().map(frame => frame.url());
      if (frameUrls.some(frameUrl => frameUrl !== 'about:blank' && (!frameUrl.startsWith('about:') && new URL(frameUrl).origin !== expected.origin))) {
        throw new Error('Read-only page contains a foreign frame');
      }
      stableNavigation = navigation;
      stableFrames = frameSignature();
      const body = await work.locator('body').innerText({ timeout: remaining() });
      assertStable();
      const one = (pattern: RegExp) => {
        const matches = [...body.matchAll(pattern)];
        return matches.length === 1 ? matches[0]![1] : undefined;
      };
      const operator = one(/OPR\s+(\S+)/g);
      const branch = one(/BR\s+(\S+)/g);
      const session = one(/SID\s+(\S+)/g);
      if (!operator || !branch || !session) throw new Error('Read-only page identity is missing or ambiguous');
      this.opts.sensitive?.([operator, branch, session], [session]);
      const results: Array<Array<Record<string, string>>> = [];
      for (const table of tables) {
        assertStable();
        const { locator, frame } = await this.resolveOnPage(page, table.target, remaining(), false);
        if (frame !== work) throw new Error('Read-only table did not resolve in the bound member frame');
        results.push(await this.extractTable(locator, table.columns, table.rowSelector));
        assertStable();
      }
      assertStable();
      return {
        url: work.url(),
        frameUrls,
        identity: {
          operator,
          branch,
          trusted: !!this.identity && this.identity.operator === operator && this.identity.branch === branch && this.identity.sid === session,
        },
        tables: results,
      };
    } catch (error) {
      pendingError = error;
      throw error;
    } finally {
      try { assertStable(); } catch (error) { pendingError = error; }
      let closeFailed = false;
      for (const opened of [...unexpectedPages, page]) {
        try { if (!opened.isClosed()) await opened.close(); }
        catch { closeFailed = true; }
        if (!opened.isClosed()) closeFailed = true;
      }
      if (!closeFailed) {
        this.context.off('page', closeUnexpectedPage);
        await this.context.unroute('**/*', routeReadOnlyRequest).catch(() => { closeFailed = true; });
      }
      if (closeFailed) throw new Error('Read-only page cleanup failed');
      if (pendingError) throw pendingError;
    }
  }

  private async verifySignon() {
    if (!this.opts.profile || new URL(this.page.url()).pathname !== '/menu') return;
    const body = await this.page.locator('body').innerText();
    const role = body.match(/Signed on as[^\n]*\((TELLER|SUPERVISOR)\)/)?.[1];
    const operator = body.match(/OPR\s+(\S+)/)?.[1];
    const branch = body.match(/BR\s+(\S+)/)?.[1];
    const sid = body.match(/SID\s+(\S+)/)?.[1];
    this.identity = role && operator && branch && sid ? { role, operator, branch, sid } : undefined;
  }

  async prepareClick(target: TargetDescriptor, timeoutMs = DEFAULT_TIMEOUT) {
    const deadline = Date.now() + timeoutMs;
    const { locator, report, frame } = await this.resolve(target, timeoutMs);
    const handle = await locator.elementHandle({ timeout: timeoutRemaining(deadline) });
    if (!handle) throw new Error('Control disappeared');
    const args = { identity: this.identity, detectors: this.opts.profile?.detectors ?? [] };
    const resolvedFrame = this.frameContext(frame);
    // Native form data stays private, including sign-on credentials and CSRF tokens.
    let approvedBody: string | undefined;
    let inspectedFrame: FrameContext | undefined;
    return {
      inspect: async (inspectTimeoutMs?: number) => {
        explicitTimeout(inspectTimeoutMs, deadline);
        const currentFrame = this.frameContext(frame);
        if ((inspectedFrame === undefined && !sameFrameContext(currentFrame, resolvedFrame)) || (inspectedFrame && !sameFrameContext(currentFrame, inspectedFrame))) {
          throw new Error('Control frame changed');
        }
        const snapshot = await handle.evaluate(inspectControl, args);
        if (approvedBody !== undefined && approvedBody !== snapshot.body) throw new Error('Approval invalidated by changed form data');
        approvedBody = snapshot.body;
        inspectedFrame = currentFrame;
        return { ...snapshot.live, frame: currentFrame };
      },
      dispatch: async (expected: LiveControl, dispatchTimeoutMs?: number) => {
        if (approvedBody === undefined) throw new Error('Control was not inspected');
        const actionTimeout = explicitTimeout(dispatchTimeoutMs, deadline);
        const currentFrame = this.frameContext(frame);
        if (!inspectedFrame || !sameFrameContext(currentFrame, inspectedFrame) || !sameFrameContext(currentFrame, expected.frame)) throw new Error('Control frame changed');
        const expectedState = { ...expected };
        delete expectedState.frame;
        if (expected.submit) this.submission = { url: expected.destination, method: expected.method, body: approvedBody };
        try {
          await Promise.all([
            frame.waitForNavigation({ waitUntil: 'load', timeout: actionTimeout }),
            handle.evaluate(inspectControl, { ...args, expected: expectedState, body: approvedBody }),
          ]);
          await this.verifySignon();
          return report;
        } finally { this.submission = undefined; await handle.dispose(); }
      },
    };
  }

  async close(): Promise<void> {
    await this.browser?.close();
  }

  // ---------- Locator resolution (the determinism core) ----------

  private framesToSearch(frameName?: string, page = this.page): Frame[] {
    const all = page
      .frames()
      .filter((f) => f.url() !== 'about:blank' && this.frameInBounds(f));
    if (frameName === undefined) return all;
    if (frameName === '') return [page.mainFrame()].filter((f) => this.frameInBounds(f));
    const matches = all.filter((f) => f.name() === frameName);
    if (!matches.length) throw new Error('Requested frame does not exist; omit frame for the main page or use a frame name from the observation');
    return matches;
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
  ): Promise<{ locator: Locator; report: ResolutionReport; frame: Frame }> {
    return this.resolveOnPage(this.page, target, timeoutMs, true);
  }

  private async resolveOnPage(
    page: Page,
    target: TargetDescriptor,
    timeoutMs: number,
    rememberFrame: boolean,
  ): Promise<{ locator: Locator; report: ResolutionReport; frame: Frame }> {
    const deadline = Date.now() + timeoutMs;
    let attempts: Array<{ kind: string; matches: number }> = [];
    do {
      attempts = [];
      for (let i = 0; i < target.strategies.length; i++) {
        const strategy = target.strategies[i]!;
        for (const frame of this.framesToSearch(target.frame, page)) {
          let locator = this.buildLocator(frame, strategy);
          let count = 0;
          try {
            count = await locator.count();
          } catch {
            count = 0;
          }
          attempts.push({ kind: strategy.kind, matches: count });
          if (count === 1 || (count > 1 && target.nth !== undefined)) {
            if (Date.now() >= deadline) break;
            if (count > 1) locator = locator.nth(target.nth!);
            if (rememberFrame) this.lastFrameContext = this.frameContext(frame);
            return { locator, report: { strategyUsed: i, kind: strategy.kind, matches: count }, frame };
          }
        }
      }
      if (Date.now() >= deadline) break;
      await page.waitForTimeout(Math.min(250, Math.max(1, deadline - Date.now())));
    } while (Date.now() < deadline);
    throw new TargetResolutionError(target, attempts);
  }

  // ---------- Descriptor derivation (used by the recorder) ----------

  /**
   * Resolve the element via the discovery-time hint, then derive a tiered,
   * replay-grade descriptor from the live element's own properties.
   */
  async describeTarget(hint: TargetDescriptor, timeoutMs = DEFAULT_TIMEOUT): Promise<TargetDescriptor> {
    const deadline = Date.now() + timeoutMs;
    const { locator } = await this.resolve(hint, timeoutMs);
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
    }, { timeout: timeoutRemaining(deadline) });
    timeoutRemaining(deadline);

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

// Recheck and dispatch in the same browser task, using the same DOM element.
interface TargetIdentity { operator: string; branch: string; role: string; sid: string }
function canonicalForm(entries: Iterable<[string, string]>) {
  return JSON.stringify(Array.from(entries, ([k, v]) => [k.replace(/\r?\n|\r/g, '\r\n'), v.replace(/\r?\n|\r/g, '\r\n')]).sort(([a, b], [c, d]) => a! < c! ? -1 : a! > c! ? 1 : b! < d! ? -1 : b! > d! ? 1 : 0));
}
function inspectControl(element: Element, args: { identity?: TargetIdentity; detectors: AppProfile['detectors']; expected?: LiveControl; body?: string }): { live: LiveControl; body: string } {
  if (!element.isConnected) throw new Error('Control is detached');
  const input = element as HTMLInputElement;
  const form = input.form;
  const submit = !!form && (input.type === 'submit' || input.type === 'image');
  const anchor = element.closest('a');
  if (!submit && !anchor) throw new Error('Unknown clickable control');
  const destination = submit ? (input.getAttribute('formaction') ? input.formAction : form!.action) : anchor!.href;
  const method = submit ? (input.getAttribute('formmethod') ? input.formMethod : form!.method).toUpperCase() : 'GET';
  const body = document.body.innerText;
  const facts: Record<string, string> = {};
  // Method shorthand keeps this serialized function independent of tsx's
  // module-scoped __name helper for assigned function expressions.
  const { addFact, isRendered, renderedText, ownLabels, siblingReviewTables } = {
    addFact(name: string, value: string) {
      if (Object.hasOwn(facts, name)) throw new Error('Duplicate form fact');
      facts[name] = value;
    },
    isRendered(node: Element | null): node is Element {
      if (!node || node.getClientRects().length === 0) return false;
      const style = getComputedStyle(node);
      return style.display !== 'none' && style.visibility !== 'hidden';
    },
    renderedText(node: Element | null) {
      return node ? (node as HTMLElement).innerText.trim() : '';
    },
    ownLabels(table: HTMLTableElement) {
      return Array.from(table.querySelectorAll('tr'))
        .filter(row => row.closest('table') === table && isRendered(row))
        .flatMap(row => Array.from(row.children).filter(cell => cell.matches('td.lbl') && isRendered(cell) && isRendered(cell.nextElementSibling)));
    },
    siblingReviewTables(reviewForm: HTMLFormElement) {
      const cell = reviewForm.parentElement;
      if (!cell?.matches('td')) return [];
      const forms = Array.from(cell.querySelectorAll('form'));
      if (forms.length !== 1 || forms[0] !== reviewForm) return [];
      return Array.from(cell.children)
        .filter(child => child.matches('div.box'))
        .flatMap(box => Array.from(box.children).filter(child => child instanceof HTMLTableElement));
    },
  };
  if (submit && new URL(destination).pathname !== '/signon') {
    for (const field of Array.from(form!.elements) as HTMLInputElement[]) {
      if (field.name && field.name !== '_token' && field.type !== 'password') {
        addFact(field.name, field.value);
      }
    }
    const destinationPath = new URL(destination).pathname;
    const canonicalReview = [
      { name: 'Transfer', route: 'transfer', labels: new Set(['Member:', 'From:', 'To:', 'Amount:', 'Memo:']) },
      { name: 'Open-share', route: 'open-share', labels: new Set(['Member:', 'Share Type:', 'Initial Deposit:']) },
      { name: 'Hold', route: 'hold', labels: new Set(['Member:', 'Share:', 'Reason:', 'Notes:']) },
    ].find(review => new RegExp(`^/members/\\d+/${review.route}/review$`).test(location.pathname)
      || new RegExp(`^/members/\\d+/${review.route}/post$`).test(destinationPath));
    const tables = Array.from(new Set([
      ...Array.from(form!.querySelectorAll('table')),
      ...(form!.closest('table') ? [form!.closest('table')!] : []),
      ...(canonicalReview ? siblingReviewTables(form!) : []),
    ])) as HTMLTableElement[];
    let reviewTable: HTMLTableElement | null;
    let reviewLabels: Element[];
    if (canonicalReview) {
      const candidates = tables.map(table => ({ table, labels: ownLabels(table) }))
        .filter(candidate => isRendered(candidate.table))
        .filter(candidate => candidate.labels.some(label => canonicalReview.labels.has(renderedText(label))));
      const complete = candidates.filter(candidate => {
        const labels = candidate.labels.map(renderedText);
        return canonicalReview.labels.size === new Set(labels.filter(label => canonicalReview.labels.has(label))).size
          && canonicalReview.labels.size === labels.filter(label => canonicalReview.labels.has(label)).length;
      });
      if (candidates.length === 1) {
        const labels = candidates[0]!.labels.map(renderedText).filter(label => canonicalReview.labels.has(label));
        if (new Set(labels).size !== labels.length) throw new Error('Duplicate form fact');
      }
      if (candidates.length !== 1 || complete.length !== 1) throw new Error(`${canonicalReview.name} review facts are missing or ambiguous`);
      reviewTable = complete[0]!.table;
      reviewLabels = complete[0]!.labels;
    } else {
      const nestedReviewTable = tables.find(table => table.querySelector('td.lbl'));
      reviewTable = nestedReviewTable ?? form!.closest('table');
      while (reviewTable && !reviewTable.querySelector('td.lbl')) reviewTable = reviewTable.parentElement?.closest('table') ?? null;
      reviewLabels = Array.from(reviewTable?.querySelectorAll('td.lbl') ?? []);
    }
    for (const label of reviewLabels) {
      addFact(`review:${renderedText(label)}`, renderedText(label.nextElementSibling));
    }
    const member = new URL(destination).pathname.match(/^\/members\/(\d+)/)?.[1];
    if (member) addFact('member', member);
  }
  const tokens = form?.querySelectorAll('input[type=hidden][name="_token"]');
  const tokenPresent = tokens?.length === 1 && !!(tokens[0] as HTMLInputElement).value;
  const operator = body.match(/OPR\s+(\S+)/)?.[1] ?? '';
  const branch = body.match(/BR\s+(\S+)/)?.[1] ?? '';
  const sid = body.match(/SID\s+(\S+)/)?.[1];
  const role = args.identity && args.identity.sid === sid && args.identity.operator === operator && args.identity.branch === branch ? args.identity.role : '';
  const conditions = args.detectors.filter(d => d.match.kind === 'textVisible' ? body.includes(d.match.text) : new RegExp(d.match.pattern).test(location.href)).map(d => d.id);
  const fields = submit ? Array.from(form!.elements).filter(e => {
    const field = e as HTMLInputElement;
    return field.name && !field.matches(':disabled') && (field.type !== 'submit' || e === element);
  }).map(e => {
    const field = e as HTMLInputElement;
    if (['file', 'checkbox', 'radio', 'image', 'reset', 'button', 'select-multiple'].includes(field.type)) throw new Error('Unsupported form field');
    return [field.name.replace(/\r?\n|\r/g, '\r\n'), field.value.replace(/\r?\n|\r/g, '\r\n')];
  }) : [];
  const entries = submit ? Array.from(new FormData(form!, input).entries(), ([k, v]) => {
    if (typeof v !== 'string') throw new Error('File form submissions are not supported');
    return [k.replace(/\r?\n|\r/g, '\r\n'), v.replace(/\r?\n|\r/g, '\r\n')];
  }) : [];
  const formBody = JSON.stringify(entries.sort(([a, b], [c, d]) => a! < c! ? -1 : a! > c! ? 1 : b! < d! ? -1 : b! > d! ? 1 : 0));
  if (formBody !== JSON.stringify(fields.sort(([a, b], [c, d]) => a! < c! ? -1 : a! > c! ? 1 : b! < d! ? -1 : b! > d! ? 1 : 0))) throw new Error('Native form data differs from inspected fields');
  const state: LiveControl = {
    url: location.href, destination, method, submit, control: input.type === 'submit' ? input.value : element.textContent?.trim() ?? '',
    operator, branch, role, conditions, facts, tokenPresent,
    error: !!document.querySelector('ul li') && !!document.querySelector('.err'),
  };
  if (args.expected) {
    if (args.body !== formBody || JSON.stringify(args.expected) !== JSON.stringify(state)) throw new Error('Approval invalidated by changed page state');
    (element as HTMLElement).click();
  }
  return { live: state, body: formBody };
}
