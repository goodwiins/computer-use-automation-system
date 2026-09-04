// Tool surface the discovery LLM drives. The model supplies a *hint* for how
// to find each control (role+name, text, form name, or CSS); the system
// resolves it, acts, and separately derives a robust tiered descriptor from
// the live element for the recorded artifact — so artifact quality does not
// depend on the model choosing good selectors.

import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import type { TargetDescriptor } from '../artifact/schema.js';

const targetProps = {
  frame: { type: 'string', description: 'Frame name the element lives in (from the observation), omit for main frame' },
  role: { type: 'string', description: 'ARIA role, e.g. link, button, textbox, combobox' },
  name: { type: 'string', description: 'Accessible name to match with the role' },
  text: { type: 'string', description: 'Exact visible text of the element' },
  nameAttr: { type: 'string', description: 'Form-control name attribute' },
  css: { type: 'string', description: 'CSS selector (last resort only)' },
  reason: { type: 'string', description: 'Why this action moves toward the goal' },
} as const;

export const DISCOVERY_TOOLS: ChatCompletionTool[] = [
  { type: 'function', function: { name: 'assert', description: 'Record a checkpoint that must hold during replay.',
    parameters: { type: 'object', properties: { kind: { type: 'string', enum: ['textVisible', 'urlMatches'] }, text: { type: 'string' }, pattern: { type: 'string' }, frame: { type: 'string' }, reason: { type: 'string' } }, required: ['kind', 'reason'] } } },
  {
    type: 'function',
    function: {
      name: 'click',
      description: 'Click a link, button, or other control.',
      parameters: {
        type: 'object',
        properties: {
          ...targetProps,
          risk: {
            type: 'string',
            enum: ['read', 'reversible_write', 'irreversible'],
            description: 'classify the click: does it submit/mutate state? irreversible = commits a transaction',
          },
        },
        required: ['reason', 'risk'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fill',
      description: 'Type a value into a text input.',
      parameters: {
        type: 'object',
        properties: { ...targetProps, value: { type: 'string' }, selectBy: { type: 'string', enum: ['label', 'value'] } },
        required: ['value', 'reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'select',
      description: 'Choose an option; prefer selectBy=value for stable share IDs.',
      parameters: {
        type: 'object',
        properties: { ...targetProps, value: { type: 'string' }, selectBy: { type: 'string', enum: ['label', 'value'] } },
        required: ['value', 'reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'extract',
      description: 'Read a piece of on-screen text as a named output of the capability (e.g. a balance).',
      parameters: {
        type: 'object',
        properties: { ...targetProps, outputName: { type: 'string' }, pattern: { type: 'string', description: 'Optional regex with exactly one capture and one match to extract an individual value from shared text. Never extract session tokens.' }, rowSelector: { type: 'string', description: 'CSS selecting data rows within the table; exclude header rows, including legacy td headers' }, columns: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, selector: { type: 'string' }, type: { type: 'string', enum: ['string', 'money'] }, sensitive: { type: 'boolean' } }, required: ['name', 'selector', 'type'] } } },
        required: ['outputName', 'reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'navigate',
      description: 'Go directly to a URL (must stay within the allowed origins).',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string' }, reason: { type: 'string' } },
        required: ['url', 'reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'done',
      description: 'Declare the goal achieved. Include every output you extracted.',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          outputs: { type: 'object', description: 'outputName -> value you extracted', additionalProperties: { type: 'string' } },
        },
        required: ['summary'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'escalate',
      description: 'You are stuck or the next action feels unsafe/irreversible — hand off to a human.',
      parameters: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] },
    },
  },
];

export interface TargetHint {
  frame?: string;
  role?: string;
  name?: string;
  text?: string;
  nameAttr?: string;
  css?: string;
}

/** Convert the model's hint into a (possibly multi-strategy) descriptor. */
export function hintToDescriptor(hint: TargetHint, description: string): TargetDescriptor {
  const strategies: TargetDescriptor['strategies'] = [];
  if (hint.role && hint.name) strategies.push({ kind: 'role', role: hint.role, name: hint.name });
  if (hint.nameAttr) strategies.push({ kind: 'nameAttr', name: hint.nameAttr });
  if (hint.text) strategies.push({ kind: 'text', text: hint.text, exact: true });
  if (hint.css) strategies.push({ kind: 'css', selector: hint.css });
  if (strategies.length === 0) throw new Error('Target hint needs at least one of: role+name, text, nameAttr, css');
  return { description, frame: hint.frame === '(main)' ? '' : hint.frame || undefined, strategies };
}

export function systemPrompt(goal: string, params: Record<string, string | number>, origins: string[]): string {
  const paramLines = Object.entries(params)
    .map(([k, v]) => `  - ${k} = "${v}"`)
    .join('\n');
  return `You are a computer-use agent operating a legacy back-office banking application through tools.

GOAL: ${goal}

INVOCATION PARAMETERS (these concrete values will become typed parameters of a reusable capability — use them exactly as given wherever the flow needs them):
${paramLines || '  (none)'}

Each turn you receive the current page state as an accessibility snapshot per frame. Respond with exactly one tool call per turn.

Rules:
- Stay within these origins: ${origins.join(', ')}. Never navigate elsewhere.
- Prefer targeting elements by role + accessible name, or by exact visible text. Use nameAttr for form fields. CSS only as a last resort.
- The app may use frames; pass the frame name you see in the observation.
- Use extract to read any data the goal asks for, THEN call done with those outputs.
- For extract targets inside tables, pass a css selector anchored to a stable row label rather than position, e.g. tr:has(> td:text-is('SAVINGS')) > td:nth-of-type(4) — row order can differ between records.
- Request the required final submission with click. The runtime requires separate human approval before it acts; you cannot approve it. Never claim success after a human repair without recorded checks and extraction.
- Server-bound parameters are references such as {{password}}. Fill using that reference, never request or echo the literal secret.
- Use assert for checkpoints and extract with columns for structured table rows.
- On click, classify clicks that submit forms or commit changes with the appropriate risk (read / reversible_write / irreversible).
- If an action fails, read the error, re-observe, and try a different approach. If you are stuck after a few attempts, call escalate.`;
}
