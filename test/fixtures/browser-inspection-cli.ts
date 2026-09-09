import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import { BrowserSurface } from '../../src/surface/browser.js';
import { loadProfile } from '../../src/runtime/profile.js';
import { checkDetectors } from '../../src/replay/detectors.js';

const app = express();
const transferRows = [
  ['Member:', '9001 - Fixture Member'],
  ['From:', '9001-A ($2.00)'],
  ['To:', '9001-B ($0.00)'],
  ['Amount:', '$1.00'],
  ['Memo:', 'fixture'],
].map(([label, value]) => `<tr><td class="lbl">${label}</td><td>${value}</td></tr>`).join('');
const reviewBox = `<div class="box"><table>${transferRows}</table></div>`;
const transferForm = (submit = 'Post Transfer', override = false) => `<form method="${override ? 'get' : 'post'}" action="${override ? '/noop' : '/members/9001/transfer/post'}"><input type="hidden" name="_token" value="TOKEN"><input type="hidden" name="from" value="9001-A"><input type="hidden" name="to" value="9001-B"><input type="hidden" name="amount" value="1.00"><input type="hidden" name="memo" value="fixture"><input type="submit" value="${submit}"${override ? ' formmethod="post" formaction="/members/9001/transfer/post"' : ''}></form>`;
const reviewPage = (variant: string) => {
  const boxes = variant === 'ambiguous-review' ? `${reviewBox}${reviewBox}` : variant === 'outside-cell' ? '' : reviewBox;
  const forms = variant === 'ambiguous-form' ? `${transferForm()}${transferForm('Other Post')}`
    : variant === 'nested-form' ? `${transferForm()}<div>${transferForm('Nested Post')}</div>`
      : transferForm('Post Transfer', variant === 'submit-override');
  const content = `<td id="content"><h1>CONFIRM FUNDS TRANSFER</h1><br>${boxes}<br><font class="err"></font><br><br>${forms}</td>`;
  return `<table><tr>${variant === 'outside-cell' ? `<td>${reviewBox}</td>` : ''}${content}</tr></table>`;
};

app.get('/signon', (_req, res) => res.send('<form method="post" action="/signon"><input name="operator" value="SUPER1"><input type="password" name="password" value="secret"><input name="branch" value="MAIN-001"><input type="submit" value="Sign On"></form>'));
app.get('/members/9001/transfer/review', (req, res) => res.send(reviewPage(String(req.query.variant ?? 'clean'))));
// Both texts are present on the live target; only the 403 page is a denial.
app.get('/members/9001/hold', (_req, res) => res.send('<h1>PLACE ACCOUNT HOLD</h1><p>RESTRICTED FUNCTION - SUPERVISOR OVERRIDE REQUIRED</p><form method="post" action="/members/9001/hold/review"><input type="hidden" name="_token" value="TOKEN"><select name="share"><option>9001-A</option></select><select name="reason"><option>LEGAL</option></select><input name="notes"><input type="submit" value="Continue"></form>'));
app.get('/members', (_req, res) => res.status(403).send('<h1>SUPERVISOR OVERRIDE REQUIRED</h1><p>Operator profile super1 is not authorized to perform this function. A supervisor must sign on to complete this request.</p><a href="/members/9001/hold">Return to previous screen</a>'));
let posted = 0;
app.post('/members/9001/transfer/post', (_req, res) => { posted++; res.send('<p>posted</p>'); });

const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const profile = loadProfile('meridian');
const browser = new BrowserSurface({ allowedOrigins: [origin] });

try {
  await browser.start(`${origin}/signon`);
  const signon = await browser.prepareClick({ description: 'Sign On', strategies: [{ kind: 'role', role: 'button', name: 'Sign On' }] });
  assert.deepEqual((await signon.inspect()).facts, {});

  const holdBrowser = new BrowserSurface({ allowedOrigins: [origin], profile });
  try {
    await holdBrowser.start(`${origin}/members/9001/hold`);
    assert.equal(await checkDetectors(holdBrowser, profile), null);
    const hold = await holdBrowser.prepareClick({ description: 'Continue', strategies: [{ kind: 'role', role: 'button', name: 'Continue' }] });
    assert.deepEqual((await hold.inspect()).conditions, []);
    await holdBrowser.navigate(`${origin}/members`);
    assert.equal((await checkDetectors(holdBrowser, profile))?.outcomeCode, 'PERMISSION_DENIED');
    const back = await holdBrowser.prepareClick({ description: 'Return', strategies: [{ kind: 'role', role: 'link', name: 'Return to previous screen' }] });
    assert.deepEqual((await back.inspect()).conditions, ['permission']);
  } finally { await holdBrowser.close(); }

  await browser.navigate(`${origin}/members/9001/transfer/review`);
  const postTarget = { description: 'Post Transfer', strategies: [{ kind: 'role' as const, role: 'button', name: 'Post Transfer' }] };
  const post = await browser.prepareClick(postTarget);
  const inspected = await post.inspect();
  assert.deepEqual(inspected.facts, {
    from: '9001-A', to: '9001-B', amount: '1.00', memo: 'fixture',
    'review:Member:': '9001 - Fixture Member', 'review:From:': '9001-A ($2.00)',
    'review:To:': '9001-B ($0.00)', 'review:Amount:': '$1.00', 'review:Memo:': 'fixture', member: '9001',
  });
  await post.dispatch(inspected, 3000);
  assert.equal(posted, 1);

  for (const variant of ['ambiguous-review', 'ambiguous-form', 'nested-form', 'outside-cell']) {
    await browser.navigate(`${origin}/members/9001/transfer/review?variant=${variant}`);
    const unsafe = await browser.prepareClick(postTarget);
    await assert.rejects(unsafe.inspect(), /missing or ambiguous/);
  }

  await browser.navigate(`${origin}/members/9001/transfer/review?variant=submit-override`);
  const override = await browser.prepareClick(postTarget);
  const overridden = await override.inspect();
  assert.equal(overridden.method, 'POST');
  assert.equal(overridden.destination, `${origin}/members/9001/transfer/post`);

  await browser.navigate(`${origin}/members/9001/transfer/review`);
  const changed = await browser.prepareClick(postTarget);
  const approved = await changed.inspect();
  await browser.page.locator('#content').evaluate(cell => {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = '<form method="post" action="/members/9001/transfer/post"><input type="submit" value="Nested Post"></form>';
    cell.append(wrapper);
  });
  await assert.rejects(changed.dispatch(approved, 1000), /missing or ambiguous/);
  assert.equal(posted, 1);

  const table = { description: 'review facts', strategies: [{ kind: 'css' as const, selector: '.box > table' }] };
  const rows = await browser.readTable(table, [{ name: 'value', selector: 'td:nth-child(2)', type: 'string' }]);
  assert.equal(rows.length, 5);
  await assert.rejects(browser.readTable(table, [{ name: 'value', selector: 'td', type: 'string' }]), { failure: 'cell_count' });
  await assert.rejects(browser.readTable(table, [{ name: 'value', selector: 'td:has-text("PRIVATE")', type: 'string' }]), { failure: 'invalid_selector' });
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}
