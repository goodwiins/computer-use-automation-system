import { moneyCents, Parameter, type CapabilityArtifact, type OutputValue, type TableColumn, type TargetDescriptor } from '../artifact/schema.js';
import { InsufficientFundsError } from '../replay/outcomes.js';

export type TransferFacts = {
  member: string; sourceShare: string; destinationShare: string;
  amount: string; memo: string;
};
export type TransferShare = { share: string; status: string; balance: string };
export type OpenShareFacts = { member: string; shareType: string; deposit: string };
export type OpenShareResult = OpenShareFacts & { shareId: string };
export type MemberUpdateFacts = { member: string; email: string; phone: string; address: string };
export type HoldFacts = { member: string; share: string; reason: string; notes: string };
export type HoldResult = { member: string; share: string; status: string };
export type HoldShare = { share: string; type: string; status: string };

/** Observed in the approved member-record extraction; values are never interpolated into its selectors. */
export const meridianTransferMemberTable: {
  target: TargetDescriptor; columns: TableColumn[]; rowSelector: string;
} = {
  target: {
    description: 'the observed member shares table',
    strategies: [{ kind: 'css', selector: 'body > table:nth-of-type(1) > tbody:nth-of-type(1) > tr:nth-of-type(3) > td:nth-of-type(1) > table:nth-of-type(2)' }],
  },
  columns: [
    { name: 'shareId', selector: 'td:nth-of-type(1)', type: 'string', sensitive: true },
    { name: 'type', selector: 'td:nth-of-type(2)', type: 'string', sensitive: true },
    { name: 'balance', selector: 'td:nth-of-type(3)', type: 'money', sensitive: true },
    { name: 'status', selector: 'td:nth-of-type(4)', type: 'string', sensitive: true },
  ],
  rowSelector: 'tr:not(:first-child)',
};

/** Observed first leaf table on the approved member-record page. */
export const meridianMemberContactTable: {
  target: TargetDescriptor; columns: TableColumn[]; rowSelector: string;
} = {
  target: {
    description: 'the observed member contact table',
    strategies: [{ kind: 'css', selector: 'body > table:nth-of-type(1) > tbody:nth-of-type(1) > tr:nth-of-type(3) > td:nth-of-type(1) > table:nth-of-type(1)' }],
  },
  columns: [
    { name: 'memberLabel', selector: 'tr:nth-of-type(1) > td:nth-of-type(1)', type: 'string', sensitive: true },
    { name: 'member', selector: 'tr:nth-of-type(1) > td:nth-of-type(2)', type: 'string', sensitive: true },
    { name: 'nameLabel', selector: 'tr:nth-of-type(1) > td:nth-of-type(3)', type: 'string', sensitive: true },
    { name: 'name', selector: 'tr:nth-of-type(1) > td:nth-of-type(4)', type: 'string', sensitive: true },
    { name: 'emailLabel', selector: 'tr:nth-of-type(2) > td:nth-of-type(1)', type: 'string', sensitive: true },
    { name: 'email', selector: 'tr:nth-of-type(2) > td:nth-of-type(2)', type: 'string', sensitive: true },
    { name: 'phoneLabel', selector: 'tr:nth-of-type(2) > td:nth-of-type(3)', type: 'string', sensitive: true },
    { name: 'phone', selector: 'tr:nth-of-type(2) > td:nth-of-type(4)', type: 'string', sensitive: true },
    { name: 'addressLabel', selector: 'tr:nth-of-type(3) > td:nth-of-type(1)', type: 'string', sensitive: true },
    { name: 'address', selector: 'tr:nth-of-type(3) > td:nth-of-type(2)', type: 'string', sensitive: true },
  ],
  rowSelector: 'tbody',
};

export function transferFactsFromParams(params: Record<string, string | number>): TransferFacts | undefined {
  const names = ['member', 'sourceShare', 'destinationShare', 'amount', 'memo'] as const;
  if (!names.every(name => typeof params[name] === 'string')) return undefined;
  return Object.fromEntries(names.map(name => [name, params[name]!])) as TransferFacts;
}

export function openShareFactsFromParams(params: Record<string, string | number>): OpenShareFacts | undefined {
  const names = ['member', 'shareType', 'deposit'] as const;
  if (!names.every(name => typeof params[name] === 'string')) return undefined;
  return Object.fromEntries(names.map(name => [name, params[name]!])) as OpenShareFacts;
}

export function memberUpdateFactsFromParams(params: Record<string, string | number>): MemberUpdateFacts | undefined {
  const names = ['member', 'email', 'phone', 'address'] as const;
  if (!names.every(name => typeof params[name] === 'string')) return undefined;
  return Object.fromEntries(names.map(name => [name, params[name]!])) as MemberUpdateFacts;
}

export function holdFactsFromParams(params: Record<string, string | number>): HoldFacts | undefined {
  const names = ['member', 'share', 'reason', 'notes'] as const;
  if (!names.every(name => typeof params[name] === 'string')) return undefined;
  return Object.fromEntries(names.map(name => [name, params[name]!])) as HoldFacts;
}

const transferCheckFailed = (): never => { throw new Error('Transfer facts failed validation'); };
const openShareCheckFailed = (): never => { throw new Error('Open-share facts failed validation'); };
const memberUpdateCheckFailed = (): never => { throw new Error('Member-update facts failed validation'); };
const holdCheckFailed = (): never => { throw new Error('Hold facts failed validation'); };

function positiveCents(value: string): number {
  try {
    const cents = moneyCents(value);
    if (cents <= 0) return transferCheckFailed();
    return cents;
  } catch {
    return transferCheckFailed();
  }
}

export function assertTransferEligibility(expected: TransferFacts, actualMember: string, shares: TransferShare[]): void {
  if (!expected.member || !expected.sourceShare || !expected.destinationShare || actualMember !== expected.member || expected.sourceShare === expected.destinationShare) return transferCheckFailed();
  const amount = positiveCents(expected.amount);
  const seen = new Set<string>();
  for (const row of shares) {
    if (!row.share || seen.has(row.share)) return transferCheckFailed();
    seen.add(row.share);
  }
  const selected = [expected.sourceShare, expected.destinationShare].map(share => {
    const matches = shares.filter(row => row.share === share);
    if (matches.length !== 1) return transferCheckFailed();
    return matches[0]!;
  });
  if (selected.some(row => row.status !== 'OPEN')) return transferCheckFailed();
  let sourceBalance: number;
  try {
    sourceBalance = moneyCents(selected[0]!.balance);
    moneyCents(selected[1]!.balance);
  } catch { return transferCheckFailed(); }
  if (sourceBalance < amount) throw new InsufficientFundsError();
}

export function assertTransferFacts(expected: TransferFacts, actual: TransferFacts): void {
  if (!expected.member || !expected.sourceShare || !expected.destinationShare || expected.sourceShare === expected.destinationShare || expected.member !== actual.member || expected.sourceShare !== actual.sourceShare || expected.destinationShare !== actual.destinationShare || expected.memo !== actual.memo) return transferCheckFailed();
  const expectedAmount = positiveCents(expected.amount);
  const actualAmount = positiveCents(actual.amount);
  if (expectedAmount !== actualAmount) return transferCheckFailed();
}

export function assertTransferOutputs(expected: TransferFacts, outputs: Record<string, OutputValue>): void {
  if (Object.keys(outputs).length !== 2 || !Object.hasOwn(outputs, 'confirmation') || !Object.hasOwn(outputs, 'transaction')) return transferCheckFailed();
  if (!Object.hasOwn(outputs, 'confirmation') || typeof outputs.confirmation !== 'string' || !outputs.confirmation.trim()) return transferCheckFailed();
  if (!Object.hasOwn(outputs, 'transaction') || !Array.isArray(outputs.transaction) || outputs.transaction.length !== 1) return transferCheckFailed();
  const row = outputs.transaction[0]!;
  const fields = ['member', 'sourceShare', 'destinationShare', 'amount', 'memo', 'confirmation'];
  if (!row || typeof row !== 'object' || Object.keys(row).length !== fields.length || fields.some(field => !Object.hasOwn(row, field) || typeof row[field] !== 'string')) return transferCheckFailed();
  if (row.confirmation !== outputs.confirmation) return transferCheckFailed();
  assertTransferFacts(expected, {
    member: row.member!,
    sourceShare: row.sourceShare!,
    destinationShare: row.destinationShare!,
    amount: row.amount!,
    memo: row.memo!,
  });
}

export function assertOpenShareFacts(expected: OpenShareFacts, actual: OpenShareFacts): void {
  if (!expected.member || !expected.shareType || expected.member !== actual.member || expected.shareType !== actual.shareType) return openShareCheckFailed();
  try {
    const expectedDeposit = moneyCents(expected.deposit);
    const actualDeposit = moneyCents(actual.deposit);
    if (expectedDeposit <= 0 || actualDeposit <= 0 || expectedDeposit !== actualDeposit) return openShareCheckFailed();
  } catch { return openShareCheckFailed(); }
}

export function assertOpenShareResult(expected: OpenShareFacts, priorShareIds: readonly string[], actual: OpenShareResult, outputs: Record<string, OutputValue>): void {
  assertOpenShareFacts(expected, actual);
  if (!actual.shareId.trim() || priorShareIds.some(id => !id.trim()) || new Set(priorShareIds).size !== priorShareIds.length || priorShareIds.includes(actual.shareId)) return openShareCheckFailed();
  if (Object.keys(outputs).length !== 1 || typeof outputs.shareId !== 'string' || outputs.shareId !== actual.shareId) return openShareCheckFailed();
}

export function assertMemberUpdateFacts(expected: MemberUpdateFacts, actual: MemberUpdateFacts): void {
  if (expected.member !== actual.member || expected.email !== actual.email || expected.phone !== actual.phone || expected.address !== actual.address) return memberUpdateCheckFailed();
}

export function assertHoldFacts(expected: HoldFacts, actual: HoldFacts, role: 'TELLER' | 'SUPERVISOR'): void {
  if (role !== 'SUPERVISOR' || !expected.member || !expected.share || !expected.reason
    || !['FRAUD', 'LEGAL', 'DECEASED'].includes(expected.reason)
    || expected.member !== actual.member || expected.share !== actual.share
    || expected.reason !== actual.reason || expected.notes !== actual.notes) return holdCheckFailed();
}

export function assertHoldEligibility(expected: HoldFacts, actualMember: string, shares: readonly HoldShare[]): void {
  if (actualMember !== expected.member) return holdCheckFailed();
  const matches = shares.filter(row => row.share === expected.share);
  if (matches.length !== 1 || !matches[0]!.type.trim() || matches[0]!.status !== 'OPEN') return holdCheckFailed();
}

export function assertHoldResult(expected: HoldFacts, actual: HoldResult, outputs: Record<string, OutputValue>): void {
  if (actual.member !== expected.member || actual.share !== expected.share || actual.status !== 'HOLD'
    || Object.keys(outputs).length !== 1 || typeof outputs.heldShare !== 'string' || outputs.heldShare !== actual.share) return holdCheckFailed();
}

const TRANSFER_TRANSACTION_COLUMNS = [
  { name: 'member', type: 'string' },
  { name: 'sourceShare', type: 'string' },
  { name: 'destinationShare', type: 'string' },
  { name: 'amount', type: 'money' },
  { name: 'memo', type: 'string' },
  { name: 'confirmation', type: 'string' },
] as const;

function hasCanonicalTransferColumns(columns: readonly TableColumn[] | undefined): boolean {
  if (!columns || columns.length !== TRANSFER_TRANSACTION_COLUMNS.length || new Set(columns.map(column => column.name)).size !== columns.length) return false;
  return TRANSFER_TRANSACTION_COLUMNS.every(expected => columns.some(column =>
    column.name === expected.name && column.type === expected.type && column.sensitive === true));
}

function assertTransferOutputDeclaration(outputs: CapabilityArtifact['outputs']): void {
  const confirmation = outputs.find(output => output.name === 'confirmation');
  const transaction = outputs.find(output => output.name === 'transaction');
  if (!confirmation || confirmation.type !== 'string' || confirmation.sensitive !== true || confirmation.columns?.length) {
    throw new Error('Transfer confirmation output must be a sensitive string');
  }
  if (!transaction || transaction.type !== 'table' || transaction.sensitive !== true || (transaction.minRows !== undefined && transaction.minRows !== 1) || !hasCanonicalTransferColumns(transaction.columns)) {
    throw new Error('Transfer transaction output must declare one canonical sensitive row');
  }
}

const MERIDIAN_SCALAR_WRITE_OUTPUTS = {
  'meridian-open-share': 'shareId',
  'meridian-update-member': 'saved',
  'meridian-place-hold': 'heldShare',
} as const;

export function assertMeridianScalarWriteOutputs(artifact: CapabilityArtifact): void {
  if (artifact.app.appId !== 'meridian' || !Object.hasOwn(MERIDIAN_SCALAR_WRITE_OUTPUTS, artifact.id)) return;
  const expected = MERIDIAN_SCALAR_WRITE_OUTPUTS[artifact.id as keyof typeof MERIDIAN_SCALAR_WRITE_OUTPUTS];
  const output = artifact.outputs[0];
  const extracts = artifact.steps.filter(step => step.action === 'extract' && step.extract);
  if (artifact.outputs.length !== 1 || !output || output.name !== expected || output.type !== 'string'
    || output.columns !== undefined || output.minRows !== undefined || extracts.length !== 1
    || extracts[0]!.extract!.output !== expected || extracts[0]!.extract!.columns !== undefined) {
    throw new Error(`${artifact.id} must declare and extract exactly one scalar string output`);
  }
}

const string = (name: string, description: string, extra = {}) => Parameter.parse({ name, type: 'string', description, sensitive: true, ...(name === 'member' ? { pattern: '^[0-9]{1,12}$' } : ['sourceShare', 'destinationShare', 'share'].includes(name) ? { pattern: '^[0-9]{1,12}-[A-Za-z0-9-]+$' } : {}), ...extra });
/** Contract names guide discovery; only recorded extracts may become outputs. */
export const meridianContracts = {
  'meridian-sign-on': { parameters: [], outputs: ['operator', 'branch', 'role'] },
  'meridian-member-inquiry': { parameters: [string('searchMode', 'Search by member number or last name', { enum: ['number', 'name'], sensitive: false }), string('searchValue', 'Exact search value')], outputs: ['members'] },
  'meridian-member-record': { parameters: [string('member', 'Member number')], outputs: ['shares'] },
  'meridian-funds-transfer': { parameters: [string('member', 'Member number'), string('sourceShare', 'Stable source share ID'), string('destinationShare', 'Stable destination share ID'), string('amount', 'Decimal amount', { format: 'positiveMoney' }), string('memo', 'Transfer memo')], outputs: ['confirmation', 'transaction'] },
  'meridian-open-share': { parameters: [string('member', 'Member number'), string('shareType', 'New share type', { enum: ['S0001', 'S0070', 'MMKT', 'CERT'], sensitive: false }), string('deposit', 'Decimal initial deposit', { format: 'positiveMoney' })], outputs: ['shareId'] },
  'meridian-update-member': { parameters: [string('member', 'Member number'), string('email', 'Email address'), string('phone', 'Phone number'), string('address', 'Mailing address')], outputs: ['saved'] },
  'meridian-place-hold': { parameters: [string('member', 'Member number'), string('share', 'Stable share ID'), string('reason', 'Hold reason', { enum: ['FRAUD', 'LEGAL', 'DECEASED'], sensitive: false }), string('notes', 'Hold notes')], outputs: ['heldShare'] },
};

function executableParameterReferences(artifact: CapabilityArtifact): Set<string> {
  const templates = [artifact.app.entryUrl];
  const addAssertion = (assertion: CapabilityArtifact['successCondition'] | undefined) => {
    if (assertion) templates.push(assertion.kind === 'urlMatches' ? assertion.pattern : assertion.text);
  };
  const addTarget = (target: CapabilityArtifact['steps'][number]['target']) => {
    for (const strategy of target?.strategies ?? []) {
      if (strategy.kind === 'role') templates.push(strategy.name);
      else if (strategy.kind === 'text') templates.push(strategy.text);
      else if (strategy.kind === 'css') templates.push(strategy.selector);
    }
  };
  for (const step of artifact.steps) {
    if (step.action === 'navigate' && step.url) templates.push(step.url);
    if (['click', 'fill', 'select', 'extract'].includes(step.action)) addTarget(step.target);
    if (['fill', 'select'].includes(step.action) && step.value) templates.push(step.value);
    if (step.action === 'assert') addAssertion(step.assert);
    if (step.action === 'extract' && !step.extract?.columns && step.extract?.pattern) templates.push(step.extract.pattern);
  }
  addAssertion(artifact.successCondition);
  return new Set(templates.flatMap(template => [...template.matchAll(/\{\{(\w+)\}\}/g)].map(match => match[1]!)));
}

export function applyMeridianContract(artifact: CapabilityArtifact): CapabilityArtifact {
  if (!Object.hasOwn(meridianContracts, artifact.id)) throw new Error('Unknown MERIDIAN capability contract');
  const contract = meridianContracts[artifact.id as keyof typeof meridianContracts];
  const publicNames = artifact.parameters.filter(parameter => parameter.source !== 'server').map(parameter => parameter.name);
  const expectedPublicNames = contract.parameters.map(parameter => parameter.name);
  if (publicNames.length !== expectedPublicNames.length || new Set(publicNames).size !== publicNames.length || expectedPublicNames.some(name => !publicNames.includes(name))) {
    throw new Error(`Recording parameters must exactly match the ${artifact.id} contract`);
  }
  const executableReferences = executableParameterReferences(artifact);
  const unbound = contract.parameters.filter(parameter => parameter.required && !executableReferences.has(parameter.name));
  if (unbound.length) throw new Error(`Executable recording does not bind required parameter ${unbound[0]!.name}`);
  const outputNames = artifact.outputs.map(o => o.name);
  if (new Set(outputNames).size !== outputNames.length || outputNames.length !== contract.outputs.length || contract.outputs.some(name => !outputNames.includes(name))) {
    throw new Error(`Recording outputs must exactly match the ${artifact.id} contract`);
  }
  assertMeridianScalarWriteOutputs(artifact);
  for (const name of contract.outputs) {
    if (!artifact.steps.some(s => s.action === 'extract' && s.extract?.output === name)) throw new Error(`Discovery must record output ${name}`);
  }
  if (!['meridian-sign-on', 'meridian-member-inquiry', 'meridian-member-record'].includes(artifact.id)) {
    const post = artifact.steps.findIndex(s => s.action === 'click' && s.risk === 'irreversible');
    if (post < 0 || !artifact.steps.slice(post + 1).some(s => s.action === 'assert') || contract.outputs.some(name => !artifact.steps.slice(post + 1).some(s => s.action === 'extract' && s.extract?.output === name))) throw new Error('Write recordings require a posting click followed by verified checkpoints and extraction');
  }
  if (!artifact.steps.some(s => s.action === 'assert')) throw new Error('MERIDIAN recording requires checkpoints');
  for (const name of ['operator', 'password', 'branch']) {
    if (!artifact.steps.some(s => ['fill', 'select'].includes(s.action) && s.value === `{{${name}}}`)) throw new Error('Every MERIDIAN capability must record sign-on');
  }
  const names = new Set([...contract.parameters.map(p => p.name), 'operator', 'password', 'branch']);
  for (const match of JSON.stringify(artifact.steps).matchAll(/\{\{(\w+)\}\}/g)) if (!names.has(match[1]!)) throw new Error('Recording contains undeclared parameter references');
  if (artifact.outputs.some(o => !contract.outputs.includes(o.name))) throw new Error('Recording contains undeclared outputs');
  if (artifact.id === 'meridian-funds-transfer') assertTransferOutputDeclaration(artifact.outputs);
  const outputs = artifact.outputs.map(o => ['members', 'shares', 'transaction'].includes(o.name) ? { ...o, type: 'table' as const, minRows: o.name === 'members' ? 0 : 1 } : o);
  if (outputs.some(o => o.type === 'table' && !o.columns?.length)) throw new Error('Structured table extraction is required');
  if (artifact.id === 'meridian-funds-transfer') {
    const confirmationExtracts = artifact.steps.filter(step => step.action === 'extract' && step.extract?.output === 'confirmation');
    const transactionExtracts = artifact.steps.filter(step => step.action === 'extract' && step.extract?.output === 'transaction');
    if (confirmationExtracts.length !== 1 || confirmationExtracts[0]!.extract?.columns || transactionExtracts.length !== 1 || !hasCanonicalTransferColumns(transactionExtracts[0]!.extract?.columns)) {
      throw new Error('Transfer recording extracts must match the canonical output columns');
    }
  }
  return { ...artifact, schemaVersion: 2, outputs, parameters: [...contract.parameters,
    ...['operator', 'password', 'branch'].map(name => string(name, 'Runtime-bound operator context', { source: 'server' }))] };
}
