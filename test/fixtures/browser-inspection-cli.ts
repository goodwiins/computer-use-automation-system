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

app.get('/signon', (_req, res) => res.send('<form method="post" action="/signon"><input name="operator" value="SUPER1"><input type="password" name="password" value="secret"><input name="branch" value="MAIN-001"><input type="submit" value="Sign On"></form>'));
app.get('/members/9001/transfer/review', (req, res) => res.send(`<form method="post" action="/members/9001/transfer/post"><input type="hidden" name="_token" value="TOKEN"><select name="from"><option value="9001-A" selected>9001-A</option></select><select name="to"><option value="9001-B" selected>9001-B</option></select><input name="amount" value="1.00"><textarea name="memo">fixture</textarea><table>${transferRows}${req.query.duplicate === '1' ? '<tr><td class="lbl">Memo:</td><td>conflicting</td></tr>' : ''}</table><input type="submit" value="Post Transfer"></form>`));

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
  assert.deepEqual((await post.inspect()).facts, {
    from: '9001-A', to: '9001-B', amount: '1.00', memo: 'fixture',
    'review:Member:': '9001 - Fixture Member', 'review:From:': '9001-A ($2.00)',
    'review:To:': '9001-B ($0.00)', 'review:Amount:': '$1.00', 'review:Memo:': 'fixture', member: '9001',
  });

  await browser.navigate(`${origin}/members/9001/transfer/review?duplicate=1`);
  const duplicate = await browser.prepareClick(postTarget);
  await assert.rejects(duplicate.inspect(), /Duplicate form fact/);
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}
