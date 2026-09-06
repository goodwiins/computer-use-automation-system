import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { Request } from 'playwright';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { loadProfile } from '../src/runtime/profile.js';
import { BrowserSurface } from '../src/surface/browser.js';

let allowed: Server;
let collector: Server;
let browser: BrowserSurface;
let origin: string;
let collectorOrigin: string;
let collected: string[];
let posted: string[];
const form = '<form method="post" action="/signon"><input name="operator" value="fixture"><input type="password" name="password" value="secret"><input type="submit" value="Sign On"></form>';

beforeEach(async () => {
  collected = [];
  posted = [];
  collector = createServer((request, response) => {
    collected.push(`${request.method} ${request.url}`);
    response.end('collected');
  }).listen(0, '127.0.0.1');
  await once(collector, 'listening');
  collectorOrigin = `http://127.0.0.1:${(collector.address() as { port: number }).port}`;
  allowed = createServer(async (request, response) => {
    if (request.url?.startsWith('/members/9999')) collected.push(`${request.method} ${request.url}`);
    if (request.method === 'POST') {
      let body = '';
      for await (const chunk of request) body += chunk;
      posted.push(body);
      response.end('signed on');
      return;
    }
    response.setHeader('content-type', 'text/html');
    response.end(`${form}<iframe name="sibling" src="about:blank"></iframe><a id="popup-link" target="_blank" href="${collectorOrigin}/collect?secret=fixture">open</a>`);
  }).listen(0, '127.0.0.1');
  await once(allowed, 'listening');
  origin = `http://127.0.0.1:${(allowed.address() as { port: number }).port}`;
  browser = new BrowserSurface({ allowedOrigins: [origin], profile: loadProfile('meridian') });
});

afterEach(async () => {
  await browser?.close();
  for (const server of [allowed, collector]) {
    server?.closeAllConnections();
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

it.each([true, false].flatMap(profileBound => ['window.open', 'target=_blank', 'POST'].map(kind => ({ profileBound, kind }))))('blocks the first $kind popup request before it reaches another origin (profile=$profileBound)', async ({ profileBound, kind }) => {
  if (!profileBound) browser = new BrowserSurface({ allowedOrigins: [origin] });
  await browser.start(`${origin}/signon`);
  const popup = browser.page.waitForEvent('popup');
  await browser.page.evaluate(({ kind, destination }) => {
    if (kind === 'window.open') window.open(destination);
    else if (kind === 'target=_blank') document.querySelector<HTMLAnchorElement>('#popup-link')!.click();
    else {
      const form = document.querySelector('form')!;
      form.target = '_blank';
      form.action = destination;
      form.submit();
    }
  }, { kind, destination: `${collectorOrigin}/collect?secret=fixture` });
  const opened = await popup;
  if (!opened.isClosed()) await opened.waitForEvent('close');
  expect(collected).toEqual([]);
  expect(posted).toEqual([]);
});

it.each(['_blank', 'sibling'])('a %s form cannot consume the primary frame native POST allowance', async target => {
  await browser.start(`${origin}/signon`);
  const context = browser.page.context();
  // Resolve when the competing native request has actually settled, before
  // sending the primary form. This makes gate ownership deterministic.
  const competitorSettled = target === '_blank' ? browser.page.waitForEvent('popup').then(async popup => {
    if (!popup.isClosed()) await popup.waitForEvent('close');
  }) : new Promise<void>(resolve => {
    const settled = (request: Request) => {
      if (request.method() !== 'POST' || request.frame() === browser.page.mainFrame()) return;
      context.off('requestfinished', settled);
      context.off('requestfailed', settled);
      resolve();
    };
    context.on('requestfinished', settled);
    context.on('requestfailed', settled);
  });
  await browser.page.evaluate(target => {
    document.querySelector('form')!.addEventListener('submit', event => {
      event.preventDefault();
      const copy = document.querySelector('form')!.cloneNode(true) as HTMLFormElement;
      copy.target = target;
      document.body.append(copy);
      copy.submit();
    }, { once: true });
  }, target);
  const prepared = await browser.prepareClick({ description: 'Sign On', strategies: [{ kind: 'role', role: 'button', name: 'Sign On' }] });
  const expected = await prepared.inspect();
  const dispatch = prepared.dispatch(expected, 3000).then(() => undefined, error => error);
  await competitorSettled;
  expect(posted).toEqual([]);
  await browser.page.evaluate(() => document.querySelector('form')!.submit());
  expect(await dispatch).toBeUndefined();
  expect(posted).toEqual(['operator=fixture&password=secret']);
  // The allowance is one-shot, even for an exact replay in the primary frame.
  await browser.page.evaluate(() => fetch('/signon', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'operator=fixture&password=secret',
  }).catch(() => {}));
  expect(posted).toHaveLength(1);
  expect(collected).toEqual([]);
});

it('allows ordinary same-origin native forms without an app profile', async () => {
  browser = new BrowserSurface({ allowedOrigins: [origin] });
  await browser.start(`${origin}/signon`);
  await Promise.all([
    browser.page.waitForNavigation(),
    browser.page.getByRole('button', { name: 'Sign On' }).click(),
  ]);
  expect(posted).toEqual(['operator=fixture&password=secret']);
  expect(collected).toEqual([]);
});

it.each([true, false])('blocks close-time navigation after route teardown (profile=%s)', async profileBound => {
  if (!profileBound) browser = new BrowserSurface({ allowedOrigins: [origin] });
  await browser.start(`${origin}/signon`);
  const context = browser.page.context();
  const destination = profileBound ? `${origin}/members/9999` : `${collectorOrigin}/collect`;
  context.once('page', opened => {
    const nativeClose = opened.close.bind(opened);
    vi.spyOn(opened, 'close').mockImplementationOnce(async () => {
      // Model routing becoming unavailable while Chromium has not closed the
      // page yet. The close guard must still prevent actual HTTP delivery.
      await context.unroute('**/*');
      await opened.goto(destination, { timeout: 1000 }).catch(() => {});
      await nativeClose();
    });
  });
  const popup = context.waitForEvent('page');
  await browser.page.evaluate(() => { window.open('about:blank'); });
  const opened = await popup;
  if (!opened.isClosed()) await opened.waitForEvent('close');
  expect(collected).toEqual([]);
  expect(context.pages()).toEqual([browser.page]);
});

it.each(['attach', 'offline'])('does not start popup teardown when native %s fails', async stage => {
  await browser.start(`${origin}/signon`);
  const context = browser.page.context();
  const nativeSession = context.newCDPSession.bind(context);
  let close: ReturnType<typeof vi.spyOn> | undefined;
  context.once('page', opened => { close = vi.spyOn(opened, 'close'); });
  const blockFailed = new Promise<void>(resolve => {
    vi.spyOn(context, 'newCDPSession').mockImplementationOnce(async target => {
      if (stage === 'attach') {
        resolve();
        throw new Error('Fixture native session unavailable');
      }
      const session = await nativeSession(target);
      vi.spyOn(session, 'send').mockImplementationOnce(async () => {
        resolve();
        throw new Error('Fixture native network guard unavailable');
      });
      return session;
    });
  });
  const popup = context.waitForEvent('page');
  await browser.page.evaluate(() => { window.open('about:blank'); });
  const opened = await popup;
  await blockFailed;
  await expect(opened.goto(`${collectorOrigin}/collect`, { timeout: 1000 })).rejects.toThrow();
  expect(close).not.toHaveBeenCalled();
  expect(opened.isClosed()).toBe(false);
  expect(collected).toEqual([]);
});
