// Deliberately hostile, legacy-style server-rendered HTML:
// nested tables for layout, <font> tags, bgcolor attributes, generic class
// names, no test IDs, framesets. This mimics the back-office surfaces the
// real system has to drive.

import type { Member } from './data.js';

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function framesetPage(query = ''): string {
  const qs = query ? `?${query}` : '';
  return `<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Frameset//EN">
<html>
<head><title>CU*NEXUS Teller Workstation</title></head>
<frameset rows="64,*" border="1">
  <frame src="/banner" name="banner" scrolling="no">
  <frame src="/main${qs}" name="workarea">
  <noframes><body>This application requires frame support.</body></noframes>
</frameset>
</html>`;
}

export function bannerFrame(): string {
  return page(
    `<table width="100%" bgcolor="#003366" cellpadding="8"><tr>
      <td><font color="#ffffff" size="4"><b>CU*NEXUS</b> &nbsp;Teller Workstation v3.2.11</font></td>
      <td align="right"><font color="#cccccc" size="2">Operator: TELLER01 &nbsp;|&nbsp; Branch: 004</font></td>
    </tr></table>`,
    { bare: true },
  );
}

// Wraps body content in the legacy chrome. `sim=maintenance` renders a
// dismissable interstitial on top of whatever page was requested.
export function page(body: string, opts: { maintenance?: boolean; bare?: boolean } = {}): string {
  const interstitial = opts.maintenance
    ? `<table width="100%" bgcolor="#ffffcc" border="1" cellpadding="6" class="c0">
        <tr><td align="center">
          <font size="3"><b>SCHEDULED MAINTENANCE NOTICE</b></font><br>
          <font size="2">Core processing will be unavailable Sunday 02:00-04:00 ET. Transactions entered during this window will queue.</font><br>
          <a href="?ack=1">Continue to application</a>
        </td></tr>
      </table>`
    : '';
  const nav = opts.bare
    ? ''
    : `<table width="100%" bgcolor="#dddddd" cellpadding="4"><tr>
        <td class="c2"><a href="/main">Home</a> | <a href="/members/search">Member Services</a> | <a href="#" onclick="alert('Not available in this environment');return false">Reports</a></td>
      </tr></table>`;
  return `<html>
<head><title>CU*NEXUS</title></head>
<body bgcolor="#f0f0f0" text="#000000" link="#003366">
${interstitial}
${nav}
<table width="96%" align="center" cellpadding="10"><tr><td class="c1">
${body}
</td></tr></table>
</body></html>`;
}

export function mainMenu(): string {
  return `<font size="4"><b>Main Menu</b></font><hr>
<table cellpadding="6"><tr>
  <td bgcolor="#e8e8ff" class="c3"><a href="/members/search"><b>Member Inquiry / Maintenance</b></a><br><font size="2">Inquiry, maintenance, sub-accounts</font></td>
  <td bgcolor="#e8ffe8" class="c3"><a href="#" onclick="alert('Not available in this environment');return false"><b>Transaction Processing</b></a><br><font size="2">Deposits, withdrawals, transfers</font></td>
</tr></table>`;
}

export function searchForm(err?: string): string {
  return `<font size="4"><b>Member Inquiry</b></font><hr>
${err ? `<font color="#cc0000"><b>${esc(err)}</b></font><br>` : ''}
<form method="GET" action="/members/search">
<table cellpadding="4"><tr>
  <td><font size="2">Member Number or Last Name:</font></td>
  <td><input type="text" name="q" size="24"></td>
  <td><input type="submit" value="${process.env.BREAK_MARKUP ? 'Execute Query' : 'Search'}"></td>
</tr></table>
</form>
<font size="1" color="#666666">Tip: full member numbers return the record directly.</font>`;
}

export function searchResults(q: string, members: Member[]): string {
  if (members.length === 0) {
    return `<font size="4"><b>Member Inquiry</b></font><hr>
<table bgcolor="#fff0f0" border="1" cellpadding="6" class="c4"><tr><td>
<font size="3"><b>No records found</b></font><br>
<font size="2">Your search for &quot;${esc(q)}&quot; returned no results. Verify the member number and try again.</font>
</td></tr></table>
<br><a href="/members/search">New search</a>`;
  }
  const rows = members
    .map(
      (m) => `<tr>
        <td class="c5"><a href="/members/${m.id}">${m.id}</a></td>
        <td class="c5">${esc(m.name)}</td>
        <td class="c5">***-**-${m.ssnLast4}</td>
        <td class="c5">${m.joined}</td>
      </tr>`,
    )
    .join('\n');
  return `<font size="4"><b>Search Results</b></font><hr>
<table border="1" cellpadding="4" width="100%">
  <tr bgcolor="#ccccff"><td><b>Member #</b></td><td><b>Name</b></td><td><b>Tax ID</b></td><td><b>Member Since</b></td></tr>
  ${rows}
</table>
<br><a href="/members/search">New search</a>`;
}

export function memberDetail(m: Member): string {
  const acctRows = m.accounts
    .map(
      (a) => `<tr>
        <td class="c7">${a.number}</td>
        <td class="c7">${a.type}</td>
        <td class="c7">${esc(a.nickname)}</td>
        <td class="c7" align="right">${a.balance}</td>
      </tr>`,
    )
    .join('\n');
  return `<font size="4"><b>Member Profile</b></font><hr>
<table cellpadding="2">
  <tr><td><font size="2"><b>Member #:</b></font></td><td><font size="2">${m.id}</font></td></tr>
  <tr><td><font size="2"><b>Name:</b></font></td><td><font size="2">${esc(m.name)}</font></td></tr>
  <tr><td><font size="2"><b>Member Since:</b></font></td><td><font size="2">${m.joined}</font></td></tr>
</table>
<br>
<font size="3"><b>Accounts</b></font>
<table border="1" cellpadding="4" width="100%">
  <tr bgcolor="#ccccff"><td><b>Account</b></td><td><b>Type</b></td><td><b>Description</b></td><td><b>Current Balance</b></td></tr>
  ${acctRows}
</table>
<br>
<a href="/members/${m.id}/subaccount/new">Open new sub-account</a> &nbsp;|&nbsp; <a href="/members/search">Back to inquiry</a>`;
}

export function subAccountForm(m: Member, errors: string[] = [], values: Record<string, string> = {}): string {
  const errBlock = errors.length
    ? `<table bgcolor="#fff0f0" border="1" cellpadding="4" class="c4"><tr><td>
        <font color="#cc0000" size="2"><b>Correct the following before continuing:</b><br>
        ${errors.map((e) => `&bull; ${esc(e)}`).join('<br>')}</font>
      </td></tr></table><br>`
    : '';
  return `<font size="4"><b>Open Sub-Account &mdash; Member ${m.id}</b></font><hr>
${errBlock}
<form method="POST" action="/members/${m.id}/subaccount/new">
<table cellpadding="4">
  <tr><td><font size="2">Account Type:</font></td><td>
    <select name="acctType">
      <option value="">-- select --</option>
      <option value="SAVINGS"${values.acctType === 'SAVINGS' ? ' selected' : ''}>Secondary Savings</option>
      <option value="CHECKING"${values.acctType === 'CHECKING' ? ' selected' : ''}>Checking</option>
      <option value="CD"${values.acctType === 'CD' ? ' selected' : ''}>Certificate</option>
    </select>
  </td></tr>
  <tr><td><font size="2">Nickname:</font></td><td><input type="text" name="nickname" size="24" value="${esc(values.nickname ?? '')}"></td></tr>
  <tr><td><font size="2">Initial Deposit:</font></td><td><input type="text" name="deposit" size="10" value="${esc(values.deposit ?? '')}"> <font size="1">(min 5.00)</font></td></tr>
  <tr><td></td><td><input type="submit" value="Continue"></td></tr>
</table>
</form>`;
}

export function subAccountConfirm(m: Member, v: Record<string, string>): string {
  return `<font size="4"><b>Confirm New Sub-Account</b></font><hr>
<table border="1" cellpadding="4">
  <tr><td><font size="2"><b>Member:</b></font></td><td><font size="2">${m.id} ${esc(m.name)}</font></td></tr>
  <tr><td><font size="2"><b>Type:</b></font></td><td><font size="2">${esc(v.acctType ?? '')}</font></td></tr>
  <tr><td><font size="2"><b>Nickname:</b></font></td><td><font size="2">${esc(v.nickname ?? '')}</font></td></tr>
  <tr><td><font size="2"><b>Initial Deposit:</b></font></td><td><font size="2">${esc(v.deposit ?? '')}</font></td></tr>
</table>
<br>
<form method="POST" action="/members/${m.id}/subaccount/commit">
  <input type="hidden" name="acctType" value="${esc(v.acctType ?? '')}">
  <input type="hidden" name="nickname" value="${esc(v.nickname ?? '')}">
  <input type="hidden" name="deposit" value="${esc(v.deposit ?? '')}">
  <input type="submit" value="Open Account">
</form>
<a href="/members/${m.id}">Cancel</a>`;
}

export function subAccountDone(m: Member, acctNumber: string): string {
  return `<font size="4"><b>Sub-Account Opened</b></font><hr>
<table bgcolor="#f0fff0" border="1" cellpadding="6" class="c6"><tr><td>
<font size="3"><b>Confirmation</b></font><br>
<font size="2">New account <b>${esc(acctNumber)}</b> opened for member ${m.id}.</font>
</td></tr></table>
<br><a href="/members/${m.id}">Return to member profile</a>`;
}

export function sessionExpired(): string {
  return `<font size="4"><b>Session Expired</b></font><hr>
<table bgcolor="#fff0f0" border="1" cellpadding="6" class="c4"><tr><td>
<font size="3"><b>Your session has timed out</b></font><br>
<font size="2">For security, inactive sessions are terminated after 15 minutes.</font><br>
<a href="/main">Return to sign-on</a>
</td></tr></table>`;
}

export function appError(): string {
  return `<font size="4"><b>System Error</b></font><hr>
<table bgcolor="#fff0f0" border="1" cellpadding="6" class="c4"><tr><td>
<font size="3"><b>ERROR 500: TRANCODE FAILURE</b></font><br>
<font size="2">The host did not respond to the request. Contact the help desk if the problem persists. Ref: TX-${Date.now().toString(36).toUpperCase()}</font>
</td></tr></table>`;
}
