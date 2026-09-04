const $ = id => document.getElementById(id);
let credential = '', catalog = [], messages = [], timer, pendingInvoke, pendingChat;
const node = (tag, text) => { const e = document.createElement(tag); e.textContent = text; return e; };
async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json', ...options.headers } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed');
  return data;
}
function error(e) { $('status').textContent = e.message; }
$('login').onsubmit = async e => {
  e.preventDefault(); credential = $('credential').value; $('credential').value = '';
  try {
    const data = await api('/capabilities'); catalog = data.capabilities;
    $('capability').replaceChildren(...catalog.map(c => { const o = node('option', `${c.id} · ${c.version}`); o.value = c.id; return o; }));
    $('role-label').hidden = data.principal !== 'operator';
    $('workspace').hidden = false; $('status').textContent = `Connected as ${data.principal}. Reload to sign out.`;
    fields(); await refresh();
  } catch (e) { credential = ''; error(e); }
};
function fields() {
  const capability = catalog.find(c => c.id === $('capability').value);
  $('fields').replaceChildren(...(capability?.parameters ?? []).map(p => {
    const label = node('label', `${p.name} — ${p.description}`);
    const input = document.createElement(p.enum ? 'select' : 'input'); input.name = p.name; input.required = p.required;
    if (p.enum) input.replaceChildren(...p.enum.map(value => { const option = node('option', value); option.value = value; return option; }));
    else { input.type = p.type === 'number' ? 'number' : 'text'; if (p.format) input.inputMode = 'decimal'; }
    label.append(input); return label;
  }));
}
$('capability').onchange = fields;
$('invoke').onsubmit = async e => {
  e.preventDefault();
  const capability = catalog.find(c => c.id === $('capability').value); if (!capability) return;
  const args = Object.fromEntries(capability.parameters.map(p => [p.name, p.type === 'number' ? Number(e.target.elements[p.name].value) : e.target.elements[p.name].value]));
  const body = JSON.stringify({ args, operator: $('role-label').hidden ? 'TELLER' : $('operator').value });
  const fingerprint = capability.id + body;
  if (pendingInvoke?.fingerprint !== fingerprint) pendingInvoke = { fingerprint, key: crypto.randomUUID() };
  try { const run = await api(`/capabilities/${capability.id}/invoke`, { method: 'POST', body, headers: { 'Idempotency-Key': pendingInvoke.key } }); pendingInvoke = undefined; $('status').textContent = `Started ${run.runId}`; await refresh(); } catch (e) { error(e); }
};
$('chat').onsubmit = async e => {
  e.preventDefault(); const content = $('message').value;
  if (pendingChat?.content !== content) pendingChat = { content, key: crypto.randomUUID(), messages: [...messages, { role: 'user', content }].slice(-20) };
  try {
    const data = await api('/chat', { method: 'POST', headers: { 'Idempotency-Key': pendingChat.key }, body: JSON.stringify({ messages: pendingChat.messages }) });
    messages = [...pendingChat.messages, { role: 'assistant', content: data.result ? `${data.message} ${JSON.stringify(data.result)}` : data.message }].slice(-18); pendingChat = undefined;
    $('messages').replaceChildren(...messages.map(m => node('p', `${m.role}: ${m.content}`))); $('message').value = ''; await refresh();
  } catch (e) { error(e); }
};
async function refresh() {
  clearTimeout(timer);
  try {
    const runs = await api('/runs');
    $('runs').replaceChildren(...runs.reverse().map(run => {
      const article = node('article', ''); article.append(node('h3', `${run.capability} · ${run.kind} · ${run.state}`), node('p', `${run.runId}${run.step ? ` · step ${run.step}` : ''}`));
      if (run.inputs) article.append(node('pre', JSON.stringify({ inputs: run.inputs }, null, 2)));
      if (run.result) article.append(node('pre', JSON.stringify(run.result, null, 2)));
      if (run.sensitiveValuesUnavailable) article.append(node('p', 'Historical sensitive values are unavailable.'));
      if (run.intervention?.id) {
        const box = node('div', ''); box.className = 'approval'; box.append(node('h4', 'Operator review required'), node('pre', JSON.stringify(run.intervention.action ?? run.intervention.request, null, 2)));
        for (const decision of [run.intervention.request.kind === 'risk_approval' ? 'approve' : 'retry', 'abort']) {
          const button = node('button', decision === 'approve' ? 'Approve submission' : decision === 'retry' ? 'Retry after repair' : 'Abort'); button.className = decision;
          button.onclick = async () => { button.disabled = true; try { await api(`/runs/${run.runId}/decision`, { method: 'POST', body: JSON.stringify({ approvalId: run.intervention.id, decision }) }); await refresh(); } catch (e) { error(e); await refresh(); } };
          box.append(button);
        }
        article.append(box);
      } else if (run.intervention) article.append(node('p', 'Waiting for an operator.'));
      for (const file of run.evidence) {
        const button = node('button', `View ${file}`);
        button.onclick = async () => {
          try {
            const response = await fetch(`/runs/${run.runId}/evidence/${file}`, { headers: { Authorization: `Bearer ${credential}` } }); if (!response.ok) throw new Error('Evidence unavailable');
            if (file.endsWith('.png')) { const url = URL.createObjectURL(await response.blob()); const img = node('img', ''); img.alt = 'Masked run evidence'; img.src = url; img.onload = () => URL.revokeObjectURL(url); article.append(img); }
            else article.append(node('pre', await response.text()));
          } catch (e) { error(e); }
        }; article.append(button);
      }
      return article;
    }));
    if (runs.some(r => ['running', 'recovering', 'awaiting-human', 'reserved'].includes(r.state))) timer = setTimeout(refresh, 1500);
  } catch (e) { error(e); }
}
$('refresh').onclick = refresh;
