import { MERIDIAN_CAPABILITY_LABELS } from '../capability-labels.js';

type PresentationResult = {
  status: string;
  outcomeCode?: string;
  detail?: string;
  failure?: { detail?: string };
};
export type PresentationRun = { state: string; capability: string; result?: PresentationResult };

const FIELD_LABELS: Readonly<Record<string, string>> = {
  address: 'Address',
  amount: 'Amount',
  balance: 'Balance',
  confirmation: 'Confirmation',
  deposit: 'Deposit',
  destinationShare: 'Destination share',
  email: 'Email',
  heldShare: 'Held share',
  member: 'Member',
  memberNumber: 'Member',
  memo: 'Memo',
  name: 'Name',
  phone: 'Phone',
  saved: 'Saved',
  share: 'Share',
  shareId: 'Share',
  shareType: 'Share type',
  sourceShare: 'Source share',
  status: 'Status',
  transaction: 'Transaction',
};

const MONEY_FIELDS = new Set(['amount', 'balance', 'deposit']);
const READ_CAPABILITIES = new Set(['meridian-sign-on', 'meridian-member-inquiry', 'meridian-member-record']);

export function capabilityLabel(id: string): string {
  const known = MERIDIAN_CAPABILITY_LABELS.get(id);
  if (known) return known;
  return id.replace(/^meridian-/, '').replace(/[-_]+/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase());
}

export function fieldLabel(name: string): string {
  return FIELD_LABELS[name] ?? name.replace(/[-_]+/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase());
}

export function formatMoney(value: string): string {
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return value;
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [whole, fraction] = unsigned.split('.');
  const grouped = whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-$' : '$'}${grouped}${fraction === undefined ? '' : `.${fraction}`}`;
}

export function displayValue(name: string, value: unknown): string {
  const text = String(value ?? '');
  return MONEY_FIELDS.has(name) ? formatMoney(text) : text;
}

export function runPresentation(run: PresentationRun): { label: string; description: string } {
  if (run.state === 'POST_OUTCOME_UNKNOWN') return {
    label: 'Unable to verify outcome',
    description: 'The posting outcome is unknown. Investigate with a separate read-only inquiry; do not retry.',
  };
  if (run.state === 'awaiting-human') return { label: 'Awaiting review', description: 'An operator must review the current request before it can continue.' };
  if (run.state === 'recovering') return { label: 'Recovering', description: 'The run is recovering its current browser state.' };
  if (run.state === 'dispatching') return { label: 'Submitting', description: 'The approved action is being submitted. Wait for authoritative verification.' };
  if (['accepted', 'reserved', 'running'].includes(run.state)) return { label: 'In progress', description: 'The run is still in progress. Tool completion is not run completion.' };
  if (run.state === 'business_outcome' && run.result?.status === 'business_outcome') return {
    label: 'Business outcome',
    description: `${run.result.outcomeCode}${run.result.detail ? `: ${run.result.detail}` : ''}`,
  };
  if (run.state === 'interrupted') return { label: 'Interrupted', description: 'The run stopped before completion. Review its current state before starting anything new.' };
  if (run.state === 'failure' || run.result?.status === 'failure') return {
    label: 'Run stopped',
    description: run.result?.status === 'failure' ? run.result.failure?.detail ?? 'The run stopped. Inspect the current step and safe evidence.' : 'The run stopped before completion. Inspect the current step and safe evidence.',
  };
  if (run.state === 'success' && run.result?.status === 'success') return {
    label: 'Completed',
    description: 'The run completed and its recorded result is available.',
  };
  return { label: capabilityLabel(run.state), description: 'The authoritative run state is available in Details.' };
}

export function isReadCapability(id: string): boolean {
  return READ_CAPABILITIES.has(id);
}
