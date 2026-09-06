// Minimal-but-real operator surface: the intervention request is presented
// on the operator's terminal, the human operates the SAME live (headful)
// browser window the automation was driving, and control returns via the
// terminal. Deliberately mocked: a production console would be a remote
// web UI over the same seam (see REPORT.md §5) — the control-transfer model
// and human-action capture are the real thing.

import { Redactor } from '../safety/redact.js';
import { createInterface } from 'node:readline/promises';
import type { Page } from 'playwright';
import type { RunLogger } from '../evidence/logger.js';
import { Approval, type ActionContext } from '../runtime/approval.js';
import { describePendingApproval, startApprovalServer } from './approval-cli.js';
import { ControlSession, type InterventionDecision, type InterventionRequest } from './session.js';

const terminalText = (value: string) => JSON.stringify(value).slice(1, -1);

export class OperatorConsole {
  constructor(
    private readonly page: Page,
    private readonly logger: RunLogger,
    private readonly session: ControlSession,
    private readonly redactor = new Redactor(),
  ) {}

  async intervene(req: InterventionRequest, action?: ActionContext): Promise<InterventionDecision> {
    if (this.page.isClosed()) return 'abort';
    if (req.kind === 'risk_approval') return this.approveRisk(req, action);
    this.session.transfer('human', req.reason);
    this.logger.log('handoff.to_human', { request: { ...req } });

    const detach = await this.recordHumanActions();
    await this.page.bringToFront().catch(() => {});

    console.log('\n┌──────────────── HUMAN INTERVENTION REQUIRED ────────────────');
    console.log(`│ capability : ${req.capability}`);
    console.log(`│ goal       : ${req.goal}`);
    if (req.stepId) console.log(`│ stuck at   : step ${req.stepId}`);
    console.log(`│ reason     : ${req.reason}`);
    console.log(`│ url        : ${req.url}`);
    if (req.screenshot) console.log(`│ screenshot : ${req.screenshot}`);
    console.log('│');
    console.log('│ The live browser window is now yours. Fix the state, then choose:');
    console.log('│   retry — automation re-attempts the stuck step');
    console.log('│   skip  — you completed the step manually; continue after it');
    console.log('│   abort — stop the run');
    console.log('└──────────────────────────────────────────────────────────────');

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 300_000);
    const onClose = () => controller.abort();
    this.page.on('close', onClose);
    let decision: InterventionDecision;
    for (;;) {
      const answer = (await rl.question('operator> ', { signal: controller.signal }).catch(() => 'abort')).trim().toLowerCase();
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

  private async approveRisk(req: InterventionRequest, action?: ActionContext): Promise<InterventionDecision> {
    // A piped caller must not create an endpoint that another process can use
    // to turn an unattended run into an attended one.
    if (!process.stdin.isTTY) {
      this.session.transfer('human', req.reason);
      this.logger.log('handoff.to_human', { request: { ...req } });
      const detach = await this.recordHumanActions();
      console.log('risk approval requires an interactive terminal (stdin is not a TTY); aborting');
      await detach();
      this.session.transfer('automation', 'risk approval refused: stdin is not a TTY');
      this.logger.log('handoff.to_automation', { decision: 'abort', reason: 'stdin_not_tty' });
      return 'abort';
    }

    const approval = new Approval(this.session, () => {}, Date.now() + 300_000);
    const pending = approval.wait(req, action);
    const id = approval.pending!.id;
    this.logger.log('handoff.to_human', { request: { ...req } });
    this.logger.log('intervention.pending', { kind: 'risk_approval', approvalId: id, expiresAt: approval.pending!.expiresAt });
    let detach: (() => Promise<void>) | undefined;
    let transport: Awaited<ReturnType<typeof startApprovalServer>> | undefined;
    let rl: ReturnType<typeof createInterface> | undefined;
    const controller = new AbortController();
    const onClose = () => approval.cancel();
    let decision: 'approve' | 'retry' | 'abort' = 'abort';
    try {
      this.page.on('close', onClose);
      detach = await this.recordHumanActions();
      if (this.page.isClosed()) approval.cancel();
      if (!approval.pending) return 'abort';
      transport = await startApprovalServer(action?.runId ?? this.logger.runId, approval, this.redactor);
      if (!approval.pending) return (await pending) === 'approve' ? 'retry' : 'abort';

      const details = describePendingApproval(approval.pending, this.redactor);
      console.log('\n┌──────────────── HUMAN APPROVAL REQUIRED ────────────────────');
      console.log(`│ run        : ${action?.runId ?? this.logger.runId}`);
      console.log(`│ endpoint   : ${terminalText(transport.endpoint)}`);
      console.log(`│ capability : ${terminalText(details.capability)}`);
      console.log(`│ goal       : ${terminalText(details.goal)}`);
      console.log(`│ reason     : ${terminalText(details.reason)}`);
      console.log(`│ url        : ${terminalText(details.url)}`);
      if (details.action) {
        console.log(`│ artifact   : ${terminalText(`${details.action.artifact}@${details.action.version}`)}`);
        console.log(`│ step       : ${terminalText(details.action.stepId)}`);
        console.log(`│ destination: ${terminalText(details.action.destination)}`);
        console.log(`│ method     : ${terminalText(details.action.method)}`);
        console.log(`│ operator   : ${terminalText(details.action.operator)}`);
        console.log(`│ branch     : ${terminalText(details.action.branch)}`);
        console.log(`│ role       : ${terminalText(details.action.role)}`);
        console.log(`│ control    : ${terminalText(details.action.control)}`);
        console.log(`│ token      : ${details.action.tokenPresent ? 'present' : 'missing'}`);
        console.log(`│ facts      : ${JSON.stringify(details.action.facts)}`);
      }
      console.log(`│ expires    : ${new Date(details.expiresAt).toISOString()}`);
      console.log(`│ approval   : ${details.approvalId}`);
      console.log('│');
      console.log('│ Review the facts above. Do not click the browser\'s final posting button.');
      console.log('│ Decide here or from another Terminal:');
      console.log('│   approve — allow the runner to proceed with the action');
      console.log('│   refuse  — stop the run');
      console.log(`│   npx tsx cli.ts approval --run ${action?.runId ?? this.logger.runId}`);
      console.log(`│   npx tsx cli.ts approve --run ${action?.runId ?? this.logger.runId} --approval ${id}`);
      console.log(`│   npx tsx cli.ts refuse --run ${action?.runId ?? this.logger.runId} --approval ${id}`);
      console.log('│ No response aborts the run after five minutes.');
      console.log('└──────────────────────────────────────────────────────────────');

      rl = createInterface({ input: process.stdin, output: process.stdout });
      const readDecision = (async () => {
        for (;;) {
          const answer = (await rl!.question('operator> ', { signal: controller.signal }).catch(() => {
            if (approval.pending && !controller.signal.aborted) approval.decide(id, 'abort');
            return '';
          })).trim().toLowerCase();
          if (!approval.pending) return;
          if (answer === 'approve' || answer === 'refuse' || answer === 'abort') {
            try { approval.decide(id, answer === 'approve' ? 'approve' : 'abort'); } catch { /* another input won */ }
            return;
          }
          if (!controller.signal.aborted) console.log('Please type: approve | refuse');
        }
      })();

      decision = await pending;
      controller.abort();
      await readDecision;
      return decision === 'approve' ? 'retry' : 'abort';
    } catch {
      approval.cancel();
      return (await pending) === 'approve' ? 'retry' : 'abort';
    } finally {
      approval.cancel();
      decision = await pending;
      // One terminal record for every pending ID, including startup and close races.
      this.logger.log('intervention.decided', { approvalId: id, decision });
      this.logger.log('handoff.to_automation', { decision: decision === 'approve' ? 'retry' : 'abort' });
      controller.abort();
      rl?.close();
      this.page.off('close', onClose);
      for (const close of [transport?.close, detach]) {
        try { await close?.(); }
        catch { this.logger.log('evidence.warning', { code: 'RUNTIME_CLEANUP_FAILED' }); }
      }
    }
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
