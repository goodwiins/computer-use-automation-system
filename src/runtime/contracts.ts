import { Parameter, type CapabilityArtifact } from '../artifact/schema.js';

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

export function applyMeridianContract(artifact: CapabilityArtifact): CapabilityArtifact {
  if (!Object.hasOwn(meridianContracts, artifact.id)) throw new Error('Unknown MERIDIAN capability contract');
  const contract = meridianContracts[artifact.id as keyof typeof meridianContracts];
  const outputNames = artifact.outputs.map(o => o.name);
  if (new Set(outputNames).size !== outputNames.length || outputNames.length !== contract.outputs.length || contract.outputs.some(name => !outputNames.includes(name))) {
    throw new Error(`Recording outputs must exactly match the ${artifact.id} contract`);
  }
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
  const outputs = artifact.outputs.map(o => ['members', 'shares', 'transaction'].includes(o.name) ? { ...o, type: 'table' as const, minRows: o.name === 'members' ? 0 : 1 } : o);
  if (outputs.some(o => o.type === 'table' && !o.columns?.length)) throw new Error('Structured table extraction is required');
  return { ...artifact, schemaVersion: 2, outputs, parameters: [...contract.parameters,
    ...['operator', 'password', 'branch'].map(name => string(name, 'Runtime-bound operator context', { source: 'server' }))] };
}
