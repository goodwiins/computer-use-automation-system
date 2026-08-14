// Minimal-but-real operator surface: the intervention request is presented
// on the operator's terminal, the human operates the SAME live (headful)
// browser window the automation was driving, and control returns via the
// terminal. Deliberately mocked: a production console would be a remote
// web UI over the same seam (see REPORT.md §5) — the control-transfer model
// and human-action capture are the real thing.

import { createInterface } from 'node:readline/promises';
import type { Page } from 'playwright';
import type { RunLogger } from '../evidence/logger.js';
import { ControlSession, type InterventionDecision, type InterventionRequest } from './session.js';

export class OperatorConsole {
  constructor(
    private readonly page: Page,
    private readonly logger: RunLogger,
    private readonly session: ControlSession,
  ) {}

  async intervene(req: InterventionRequest): Promise<InterventionDecision> {
    this.session.transfer('human', req.reason);
    this.logger.log('handoff.to_human', { request: { ...req } });

    const detach = await this.recordHumanActions();
    // Bring the live window to the operator's attention.
    await this.page.bringToFront().catch(() => {});

    const isRiskApproval = req.kind === 'risk_approval';

    console.log('\n┌──────────────── HUMAN INTERVENTION REQUIRED ────────────────');
    console.log(`│ capability : ${req.capability}`);
    console.log(`│ goal       : ${req.goal}`);
    if (req.stepId) console.log(`│ stuck at   : step ${req.stepId}`);
    console.log(`│ reason     : ${req.reason}`);
    console.log(`│ url        : ${req.url}`);
    if (req.screenshot) console.log(`│ screenshot : ${req.screenshot}`);
    console.log('│');
    if (isRiskApproval) {
      // A risk approval is a go/no-go on an action that has not run yet —
      // "skip" (human performed it manually) would double-execute it, so it
      // is not offered here.
      console.log('│ This action needs approval before it runs. Choose:');
      console.log('│   approve — proceed with the action');
      console.log('│   abort   — stop the run');
      console.log('└──────────────────────────────────────────────────────────────');
    } else {
      console.log('│ The live browser window is now yours. Fix the state, then choose:');
      console.log('│   retry — automation re-attempts the stuck step');
      console.log('│   skip  — you completed the step manually; continue after it');
      console.log('│   abort — stop the run');
      console.log('└──────────────────────────────────────────────────────────────');
    }

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    let decision: InterventionDecision;
    for (;;) {
      const answer = (await rl.question('operator> ')).trim().toLowerCase();
      if (isRiskApproval) {
        if (answer === 'approve') {
          decision = 'retry';
          break;
        }
        if (answer === 'abort') {
          decision = 'abort';
          break;
        }
        console.log('Please type: approve | abort');
        continue;
      }
      if (answer === 'retry' || answer === 'skip' || answer === 'abort') {
        decision = answer;
        break;
      }
      console.log('Please type: retry | skip | abort');
    }
    rl.close();

    await detach();
    this.session.transfer('automation', `operator chose ${decision}`);
    this.logger.log('handoff.to_automation', { decision });
    return decision;
  }

  /**
   * Capture what the human does while in control — clicks and field changes,
   * with values redacted — so the evidence trail covers the whole run, not
   * just the automated part.
   */
  private async recordHumanActions(): Promise<() => Promise<void>> {
    const binding = '__cuReportHumanAction';
    try {
      // The in-page listeners survive the handback (they cannot be removed
      // reliably across legacy navigations), so gate on ownership here:
      // only actions taken while a human controls the session are attributed
      // to the human.
      await this.page.exposeBinding(binding, (_source, action: unknown) => {
        if (this.session.currentOwner === 'human') this.logger.log('human.action', { action });
      });
    } catch {
      /* already exposed from a previous intervention */
    }

    const attach = async () => {
      for (const frame of this.page.frames()) {
        await frame
          .evaluate((b) => {
            const w = window as unknown as Record<string, unknown>;
            if (w['__cuRecorderAttached']) return;
            w['__cuRecorderAttached'] = true;
            const report = w[b] as (a: unknown) => void;
            document.addEventListener(
              'click',
              (e) => {
                const t = e.target as HTMLElement;
                report({ type: 'click', tag: t.tagName, text: (t.textContent ?? '').trim().slice(0, 60) });
              },
              true,
            );
            document.addEventListener(
              'change',
              (e) => {
                const t = e.target as HTMLInputElement;
                report({ type: 'change', tag: t.tagName, name: t.name, valueLength: (t.value ?? '').length });
              },
              true,
            );
          }, binding)
          .catch(() => {});
      }
    };
    await attach();
    // Legacy apps navigate constantly; re-attach the recorder on every load.
    const onNav = () => void attach();
    this.page.on('framenavigated', onNav);
    return async () => {
      this.page.off('framenavigated', onNav);
    };
  }
}
