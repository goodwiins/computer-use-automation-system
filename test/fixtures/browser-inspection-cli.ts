import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import { BrowserSurface } from '../../src/surface/browser.js';

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
let posted = 0;
app.post('/members/9001/transfer/post', (_req, res) => { posted++; res.send('<p>posted</p>'); });

const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const browser = new BrowserSurface({ allowedOrigins: [origin] });

try {
  await browser.start(`${origin}/signon`);
  const signon = await browser.prepareClick({ description: 'Sign On', strategies: [{ kind: 'role', role: 'button', name: 'Sign On' }] });
  assert.deepEqual((await signon.inspect()).facts, {});

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
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}
