// End-to-end escalation demo, fully scripted so it can run unattended.
//
// Scenario: the target app is started with BREAK_MARKUP=1, simulating a
// vendor-version drift that renames the "Search" button to "Execute Query".
// A drift-narrowed artifact (only the role-tier locator, no CSS fallback)
// hits a hard failure at that step. Replay runs attended: it raises an
// intervention, a "human operator" attaches to the SAME live browser session
// over CDP, performs the step manually, and answers `skip` — automation
// resumes at the next step and completes the flow.
//
// The CDP attach is the point: it demonstrates that the handoff seam gives an
// operator the automation's live session, not a fresh one. In production the
// same seam backs a remote co-browsing console instead of this script.

import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const CDP_PORT = process.env.CU_CDP_PORT ?? '9777';
const ARTIFACT = 'test/fixtures/drift-lookup.json';

async function operatorFixesTheStep(): Promise<void> {
  const browser = await chromium.connectOverCDP(`http://localhost:${CDP_PORT}`);
  const page = browser.contexts()[0]?.pages()[0];
  if (!page) throw new Error('operator: no live page found over CDP');
  const frame = page.frames().find((f) => f.name() === 'workarea') ?? page.mainFrame();
  console.log('[operator] attached to the live session; page:', frame.url());
  // The human recognizes the renamed button and clicks it manually.
  await frame.getByRole('button', { name: 'Execute Query' }).click();
  await page.waitForLoadState('load');
  console.log('[operator] performed the search manually; handing control back with "skip"');
  await browser.close(); // detaches from CDP; the session itself stays alive
}

const child = spawn(
  'npx',
  ['tsx', 'cli.ts', 'replay', '--artifact', ARTIFACT, '--params', '{"memberId":"12345"}', '--attended'],
  { env: { ...process.env, CU_CDP_PORT: CDP_PORT }, stdio: ['pipe', 'pipe', 'inherit'] },
);

let buffer = '';
let intervened = false;
child.stdout.on('data', (chunk: Buffer) => {
  process.stdout.write(chunk);
  buffer += chunk.toString();
  if (!intervened && buffer.includes('HUMAN INTERVENTION REQUIRED')) {
    intervened = true;
    operatorFixesTheStep()
      .then(() => child.stdin.write('skip\n'))
      .catch((err) => {
        console.error('[operator] failed:', err);
        child.stdin.write('abort\n');
      });
  }
});

child.on('close', (code) => {
  console.log(`\n[demo] replay process exited with code ${code}`);
  process.exit(code ?? 1);
});
