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
    if (this.page.isClosed()) return 'abort';
    this.session.transfer('human', req.reason);
    this.logger.log('handoff.to_human', { request: { ...req } });

    const detach = await this.recordHumanActions();
    const isRiskApproval = req.kind === 'risk_approval';
    // Browser repair happens in the live page. Risk approval happens here in
    // the terminal so the runner, not the operator, performs the action.
    if (!isRiskApproval) await this.page.bringToFront().catch(() => {});

    // "Attended" only means "a human" when the decision comes from a
    // terminal. A piped stdin is an automated caller, which must not be able
    // to approve a risky action (it may still fix stuck steps and hand back).
    if (isRiskApproval && !process.stdin.isTTY) {
      console.log('risk approval requires an interactive terminal (stdin is not a TTY); aborting');
      await detach();
      this.session.transfer('automation', 'risk approval refused: stdin is not a TTY');
      this.logger.log('handoff.to_automation', { decision: 'abort', reason: 'stdin_not_tty' });
      return 'abort';
    }

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
      console.log('│ Review the facts above. Do not click the browser\'s final posting button.');
      console.log('│ Type approve here in this Terminal and press Return to let the runner submit.');
      console.log('│   approve — allow the runner to proceed with the action');
      console.log('│   abort   — stop the run');
      console.log('│ No response aborts the run after five minutes.');
      console.log('└──────────────────────────────────────────────────────────────');
    } else {
      console.log('│ The live browser window is now yours. Fix the state, then choose:');
      console.log('│   retry — automation re-attempts the stuck step');
      console.log('│   skip  — you completed the step manually; continue after it');
      console.log('│   abort — stop the run');
      console.log('└──────────────────────────────────────────────────────────────');
    }

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 300_000);
    const onClose = () => controller.abort();
    this.page.on('close', onClose);
    let decision: InterventionDecision;
    for (;;) {
      const answer = (await rl.question('operator> ', { signal: controller.signal }).catch(() => 'abort')).trim().toLowerCase();
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
    clearTimeout(deadline);
    this.page.off('close', onClose);
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
  async recordHumanActions(): Promise<() => Promise<void>> {
    const binding = '__cuReportHumanAction';
    // The binding is callable by any script on the page, so a hostile page can
    // fire it in a loop and bury the evidence trail. Cap what one binding will
    // record.
    // ponytail: a cap, not a defence — the real fix is attributing each report
    // to a trusted event (isTrusted + a per-frame nonce). The cap is per page
    // binding, which survives handbacks, so it bounds the damage per run.
    const MAX_HUMAN_ACTIONS = 200;
    let recorded = 0;
    try {
      // The in-page listeners survive the handback (they cannot be removed
      // reliably across legacy navigations), so gate on ownership here:
      // only actions taken while a human controls the session are attributed
      // to the human.
      await this.page.exposeBinding(binding, (_source, action: unknown) => {
        if (this.session.currentOwner !== 'human') return;
        if (recorded >= MAX_HUMAN_ACTIONS) {
          if (recorded === MAX_HUMAN_ACTIONS) this.logger.log('human.action.capped', { max: MAX_HUMAN_ACTIONS });
          recorded++;
          return;
        }
        recorded++;
        this.logger.log('human.action', { action });
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
                if (!e.isTrusted) return;
                const t = e.target as HTMLElement;
                report({ type: 'click', tag: t.tagName, text: (t.textContent ?? '').trim().slice(0, 60) });
              },
              true,
            );
            document.addEventListener(
              'change',
              (e) => {
                if (!e.isTrusted) return;
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
