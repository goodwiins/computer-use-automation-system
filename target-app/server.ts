// Mock "Legacy CU Servicing" back-office app. Stands in for a legacy bank
// system: server-rendered, frameset shell, table layout, no test IDs.
// Runtime-condition injection via query params / magic member IDs:
//   ?sim=timeout      -> session-expired interstitial (any page)
//   ?sim=slow         -> 5s artificial delay
//   ?sim=maintenance  -> dismissable maintenance notice (until ?ack=1)
//   ?sim=crash        -> 500 error page
//   member 99999      -> "No records found" (legit business outcome)
//   BREAK_MARKUP=1    -> renames the search button (simulates vendor-version drift)

import express from 'express';
import { MEMBERS, openedSubAccounts } from './data.js';
import * as v from './views.js';

export function createApp() {
const app = express();
app.use(express.urlencoded({ extended: false }));

// Simulation middleware — applies to every route so any step can hit it.
app.use((req, res, next) => {
  const sim = req.query.sim;
  if (sim === 'timeout') return void res.send(v.page(v.sessionExpired()));
  if (sim === 'crash') return void res.status(500).send(v.page(v.appError()));
  if (sim === 'slow') return void setTimeout(next, 5000);
  next();
});

const maint = (req: express.Request) => req.query.sim === 'maintenance' && req.query.ack !== '1';

app.get('/', (req, res) => {
  // The frameset shell forwards its query to the working frame so simulated
  // conditions (?sim=...) reach the pages the automation actually drives.
  res.send(v.framesetPage(new URL(req.url, 'http://x').search.slice(1)));
});
app.get('/banner', (_req, res) => res.send(v.bannerFrame()));
app.get('/main', (req, res) => res.send(v.page(v.mainMenu(), { maintenance: maint(req) })));

app.get('/members/search', (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : undefined;
  if (q === undefined) return void res.send(v.page(v.searchForm(), { maintenance: maint(req) }));
  if (q === '') return void res.send(v.page(v.searchForm('Enter a member number or last name.')));
  const matches = Object.values(MEMBERS).filter(
    (m) => m.id === q || m.name.toLowerCase().includes(q.toLowerCase()),
  );
  res.send(v.page(v.searchResults(q, matches), { maintenance: maint(req) }));
});

app.get('/members/:id', (req, res) => {
  const m = MEMBERS[req.params.id];
  if (!m) return void res.send(v.page(v.searchResults(req.params.id, [])));
  res.send(v.page(v.memberDetail(m), { maintenance: maint(req) }));
});

app.get('/members/:id/subaccount/new', (req, res) => {
  const m = MEMBERS[req.params.id];
  if (!m) return void res.send(v.page(v.searchResults(req.params.id, [])));
  res.send(v.page(v.subAccountForm(m), { maintenance: maint(req) }));
});

app.post('/members/:id/subaccount/new', (req, res) => {
  const m = MEMBERS[req.params.id];
  if (!m) return void res.send(v.page(v.searchResults(req.params.id, [])));
  const { acctType = '', nickname = '', deposit = '' } = req.body;
  const errors: string[] = [];
  if (!acctType) errors.push('Account Type is required.');
  if (!nickname.trim()) errors.push('Nickname is required.');
  if (!/^\d+(\.\d{1,2})?$/.test(deposit) || parseFloat(deposit) < 5) {
    errors.push('Initial Deposit must be a dollar amount of at least 5.00.');
  }
  if (errors.length) return void res.send(v.page(v.subAccountForm(m, errors, req.body)));
  res.send(v.page(v.subAccountConfirm(m, req.body)));
});

app.post('/members/:id/subaccount/commit', (req, res) => {
  const m = MEMBERS[req.params.id];
  if (!m) return void res.send(v.page(v.searchResults(req.params.id, [])));
  const acctNumber = `${m.id}-X${(openedSubAccounts.length + 1).toString().padStart(2, '0')}`;
  openedSubAccounts.push({ memberId: m.id, ...req.body });
  res.send(v.page(v.subAccountDone(m, acctNumber)));
});

return app;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()!)) {
  const port = Number(process.env.TARGET_APP_PORT ?? 4173);
  createApp().listen(port, () => console.log(`Legacy CU Servicing (mock) on http://localhost:${port}`));
}
