# MERIDIAN UI Accessibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete MERIDIAN Unit 7 with keyboard-accessible controls, robust dialog behavior, responsive Activity navigation that preserves conversation state, readable statuses, and a source-proven Ubuntu UI walkthrough.

**Architecture:** Extend the existing `Workspace` state boundary rather than creating a second mobile navigation tree: Chat remains mounted, while Activity visibility, focus handoff, and message-scroll restoration are coordinated by refs around the current `activityOpen` state. Preserve the native `<dialog>` implementation and only add code if browser tests expose a real containment, Escape, or focus-return defect. Drive the work through the existing offline Playwright fixture, including a separately labeled headed-Chromium 200% native-zoom path under Xvfb.

**Tech Stack:** Node.js 22, Next.js 16.3.4, React 19.2.8, `@assistant-ui/react` 0.15.18, TypeScript, CSS, Vitest, Playwright Chromium, Xvfb

**Spec:** `/home/clawdbot/meridian-transfer-20260907/remaining-plans/meridian-ui-accessibility-plan.md`

## Global Constraints

- Begin from reviewed saved-conversations commit `f4e48274f22a373982fdff6d4ffe6a2e93c69b25`; do not modify shared UI from a moving dependency.
- Preserve unfinished edits by working only in `/home/clawdbot/meridian-worktrees/ui-accessibility` on `codex/meridian-ui-accessibility`.
- Preserve Stop semantics and the active conversation runtime; navigation, resize, focus, and restore actions must not send chat, approval, cancel, or transaction requests.
- Keep Chat mounted while Activity is visible so drafts and active operations survive responsive navigation.
- Use only offline browser fixtures and synthetic data. Do not perform a live transaction or represent fixture evidence as a genuine demo rehearsal.
- Verify CSS widths 320, 768, 1024, and 1440 pixels. Verify actual Chromium browser zoom at 200% separately from viewport/device emulation.
- Make status meaning readable in text and not dependent on color alone.
- Record exact source SHA, build command/result, runtime versions, fixture provenance, and zoom method in `docs/meridian/ui-walkthrough.md`.
- Do not change server or storage behavior, merge `dev`, deploy, restart the protected demo, or perform a live transaction.
- Open a scoped pull request against `dev`; because Unit 7 depends on the saved-conversations head, state that dependency explicitly in the PR.

## File Structure

- Modify `src/server/ui/main.tsx`: responsive Activity open/close handlers, Back-to-conversation control, focus handoff, and message-scroll preservation.
- Modify `src/server/ui/style.css`: narrow Activity Back control and any focused, evidence-backed accessibility fixes.
- Modify `test/chat-ui.test.ts`: offline responsive, keyboard, dialog, status, state-preservation, request-invariance, screenshot, and native-zoom coverage.
- Create `docs/meridian/ui-walkthrough.md`: final operator walkthrough and source/build/test provenance.
- Create `docs/meridian/evidence/ui-walkthrough/*.png`: synthetic offline screenshots at representative desktop, narrow, dialog, and native-zoom states.

---

### Task 1: Responsive Activity navigation without runtime loss

**Files:**
- Modify: `test/chat-ui.test.ts`
- Modify: `src/server/ui/main.tsx`
- Modify: `src/server/ui/style.css`

**Interfaces:**
- Consumes: existing `Workspace()` state `activityOpen`, `.messages` scroll container, `.thread-root` runtime subtree, and the existing `Activity` toggle.
- Produces: `openActivity(): void`, `closeActivity(): void`, an `.activity-back` button labeled `Back to conversation`, and deterministic focus/scroll restoration.

- [ ] **Step 1: Write the failing offline browser test**

Extend the Activity preservation coverage so it runs at `[320, 768, 1024, 1440]`, marks the existing `.thread-root` DOM node, fills `Draft survives Activity`, gives `.conversation` enough test-only height to set `.messages.scrollTop = 320`, and seeds `state.runs` with `initialRun()` before connecting. For each width assert:

```ts
expect(await page.locator('.thread-root').evaluate((node) =>
  (node as HTMLElement & { __unit7Mounted?: boolean }).__unit7Mounted,
)).toBe(true);
await expect(page.locator('#composer')).toHaveValue('Draft survives Activity');
await expect(page.locator('.run-state').first()).toContainText(/executing|review|complete/i);
expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
```

At 320 and 768 pixels, open Activity with keyboard Enter, require `Back to conversation` to be visible and focused, close with Enter, then require focus to return to `Activity`, the draft and active run to remain, and the previous `.messages.scrollTop` to be restored. At 1024 and 1440 pixels, require the Back control to be hidden and the split view to remain usable. Snapshot the request recorder before navigation and assert that no additional `POST` request targets `/api/chat`, `/invoke`, `/decision`, `/cancel`, or `/transaction`.

- [ ] **Step 2: Run the focused test and confirm the expected failure**

Run:

```bash
npx vitest run test/chat-ui.test.ts -t 'preserves the conversation across responsive Activity navigation'
```

Expected: FAIL because `Back to conversation` does not exist and narrow Activity cannot return through an in-panel keyboard control.

- [ ] **Step 3: Implement the minimal Workspace behavior**

In `Workspace()`, keep `<Chat />` at its current stable position and add refs for the Activity toggle, narrow Back control, and saved message scroll position. Replace the toggle expression with explicit handlers:

```tsx
const activityTriggerRef = useRef<HTMLButtonElement>(null);
const activityBackRef = useRef<HTMLButtonElement>(null);
const messageScrollTopRef = useRef(0);
const shouldRestoreConversationFocusRef = useRef(false);

const openActivity = () => {
  messageScrollTopRef.current =
    document.querySelector<HTMLElement>('.messages')?.scrollTop ?? 0;
  setActivityOpen(true);
};

const closeActivity = () => {
  shouldRestoreConversationFocusRef.current = true;
  setActivityOpen(false);
};
```

Use `useLayoutEffect` after render to focus `.activity-back` only when it has a rendered box, and after close restore `.messages.scrollTop` plus focus to `activityTriggerRef`. Wire the Activity button to `activityOpen ? closeActivity : openActivity`, add its ref, and place this control first inside the Activity panel:

```tsx
<button
  ref={activityBackRef}
  className="secondary activity-back"
  type="button"
  onClick={closeActivity}
>
  Back to conversation
</button>
```

In CSS, hide `.activity-back` by default and reveal it inside the existing `@media (max-width: 1023px)` rule:

```css
.activity-back {
  display: none;
  width: fit-content;
}

@media (max-width: 1023px) {
  .activity-back {
    display: inline-flex;
  }
}
```

- [ ] **Step 4: Run focused checks and confirm the behavior passes**

Run:

```bash
npx vitest run test/chat-ui.test.ts -t 'preserves the conversation across responsive Activity navigation'
npx tsc --noEmit -p tsconfig.json
npx tsc --noEmit -p tsconfig.ui.json
git diff --check
```

Expected: responsive test PASS, both TypeScript checks PASS, and no whitespace errors.

- [ ] **Step 5: Commit the test and implementation**

```bash
git add src/server/ui/main.tsx src/server/ui/style.css test/chat-ui.test.ts
git commit -m "feat(ui): preserve chat across responsive activity navigation"
```

---

### Task 2: Keyboard, focus, dialog, evidence, and readable-status audit

**Files:**
- Modify: `test/chat-ui.test.ts`
- Modify only if a test proves a defect: `src/server/ui/review.tsx`
- Modify only if a test proves a defect: `src/server/ui/style.css`

**Interfaces:**
- Consumes: native `<dialog>`, neutral dialog heading focus, `.operator-filter`, thread controls, `<summary>` evidence disclosure, `.error-message`, `.run-state`, and global `:focus-visible` styling.
- Produces: browser assertions proving keyboard reachability, visible focus, dialog containment/Escape/focus return, and text status names.

- [ ] **Step 1: Add keyboard and visible-focus assertions to the existing offline tests**

For Activity filters, conversation controls, evidence disclosures, review actions, and retry/error controls, enter keyboard modality with `page.keyboard.press('Tab')`, focus the target through Tab/Shift+Tab or an existing opener, and assert the computed focus indicator:

```ts
const focusStyle = await target.evaluate((node) => {
  const style = getComputedStyle(node);
  return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) };
});
expect(focusStyle.style).not.toBe('none');
expect(focusStyle.width).toBeGreaterThanOrEqual(2);
```

Open the operator-review dialog from its actual caller button, assert the neutral heading is initially focused, press Tab enough times to wrap past every dialog action, and after every press require `document.activeElement?.closest('dialog[open]')` to be the open dialog. Press Escape and require the caller button to regain focus. Assert the visible text includes `Executing`, `Awaiting review`, `Complete`, or the applicable error/retry wording rather than relying on a CSS class or color value.

- [ ] **Step 2: Run the targeted tests before changing production code**

Run:

```bash
npx vitest run test/chat-ui.test.ts -t 'operator Activity filters|operator review|neutral replacement|keyboard focus|status text'
```

Expected: existing native-dialog and text behavior may pass; any failure must identify a specific missing focus outline, containment, return target, or status label before implementation is changed.

- [ ] **Step 3: Fix only demonstrated defects**

If the global rule is overridden, restore a high-contrast keyboard indicator without suppressing native focus:

```css
:focus-visible {
  outline: 3px solid #568776;
  outline-offset: 3px;
}
```

If native Chromium containment is proven insufficient in this code path, add a dialog-local `keydown` handler that handles only Tab, obtains enabled visible controls plus the heading, and wraps first/last focus; keep the current native `cancel` handler for Escape and current opener-focus restoration. Do not replace `<dialog>`, autofocus a destructive action, or alter decision transport.

- [ ] **Step 4: Run the focused accessibility set**

Run:

```bash
npx vitest run test/chat-ui.test.ts -t 'operator Activity filters|operator review|neutral replacement|keyboard focus|status text'
npx vitest run test/conversation-ui-acceptance.test.ts
git diff --check
```

Expected: all selected browser tests PASS, including the existing saved-conversation control acceptance suite.

- [ ] **Step 5: Commit the audit coverage and any proven fix**

```bash
git add test/chat-ui.test.ts src/server/ui/review.tsx src/server/ui/style.css
git commit -m "test(ui): verify keyboard and dialog accessibility"
```

Omit unchanged production files from `git add`.

---

### Task 3: Genuine Chromium 200% zoom verification and screenshots

**Files:**
- Modify: `test/chat-ui.test.ts`
- Create: `docs/meridian/evidence/ui-walkthrough/activity-1440.png`
- Create: `docs/meridian/evidence/ui-walkthrough/activity-320.png`
- Create: `docs/meridian/evidence/ui-walkthrough/review-320.png`
- Create: `docs/meridian/evidence/ui-walkthrough/native-zoom-200.png`

**Interfaces:**
- Consumes: the existing offline `fixture()` and its request recorder.
- Produces: opt-in `MERIDIAN_NATIVE_ZOOM=1` headed-Chromium path and `MERIDIAN_WALKTHROUGH_SCREENSHOT_DIR` evidence output override.

- [ ] **Step 1: Add a separately gated native-zoom fixture mode**

Extend the fixture options with `nativeZoom200?: boolean`. When enabled, create a temporary Chromium profile, write `Default/Preferences` with Chromium's real default-partition zoom level, and launch a persistent headed context:

```ts
const zoomLevel200 = Math.log(2) / Math.log(1.2);
const preferences = {
  partition: { default_zoom_level: { x: zoomLevel200 } },
};
```

Launch with `headless: false` under Xvfb, retain the physical `1440 x 900` viewport, close the persistent context during cleanup, and remove only that temporary profile. Do not use CSS `zoom`, Playwright `deviceScaleFactor`, `force-device-scale-factor`, or CDP viewport emulation.

- [ ] **Step 2: Add the opt-in test and screenshot assertions**

Gate the test with `MERIDIAN_NATIVE_ZOOM === '1'`. Assert:

```ts
expect(metrics.devicePixelRatio).toBe(2);
expect(metrics.visualViewportScale).toBe(1);
expect(metrics.innerWidth).toBeLessThanOrEqual(720);
expect(metrics.documentWidth).toBeLessThanOrEqual(metrics.innerWidth);
```

Also assert the narrow `Back to conversation` control is visible and keyboard-functional, focus is visible, the draft and active run survive return, and navigation produces no sensitive POST. Save `native-zoom-200.png`. In the normal responsive test, direct screenshots to `MERIDIAN_WALKTHROUGH_SCREENSHOT_DIR` when set and save the 1440, 320, and narrow review states named above.

- [ ] **Step 3: Run native zoom and screenshot capture on Ubuntu/Xvfb**

Run:

```bash
mkdir -p docs/meridian/evidence/ui-walkthrough
MERIDIAN_WALKTHROUGH_SCREENSHOT_DIR=docs/meridian/evidence/ui-walkthrough \
  npx vitest run test/chat-ui.test.ts -t 'preserves the conversation across responsive Activity navigation|operator review'
xvfb-run -a env MERIDIAN_NATIVE_ZOOM=1 \
  MERIDIAN_WALKTHROUGH_SCREENSHOT_DIR=docs/meridian/evidence/ui-walkthrough \
  npx vitest run test/chat-ui.test.ts -t 'actual Chromium browser zoom at 200%'
```

Expected: both commands PASS and four PNG files exist. The native test reports DPR `2`, visual viewport scale `1`, and a CSS viewport no wider than 720 pixels from a physical 1440-pixel window.

- [ ] **Step 4: Inspect each screenshot**

Open every PNG and verify there is no horizontal clipping, overlapped text, hidden primary navigation, color-only status, or destructive initial focus. If inspection exposes a defect, add a failing assertion first, make the minimal CSS or component fix, rerun capture, and reinspect.

- [ ] **Step 5: Commit the browser evidence**

```bash
git add test/chat-ui.test.ts docs/meridian/evidence/ui-walkthrough
git commit -m "test(ui): capture responsive and native zoom evidence"
```

---

### Task 4: Source- and build-proven final UI walkthrough

**Files:**
- Create: `docs/meridian/ui-walkthrough.md`

**Interfaces:**
- Consumes: committed implementation/evidence SHA, package-lock versions, focused verification results, and synthetic screenshots.
- Produces: a durable operator walkthrough that explicitly separates offline fixture confidence from genuine demo acceptance.

- [ ] **Step 1: Record exact provenance before writing the document**

Run and retain the outputs:

```bash
git rev-parse HEAD
node --version
npm --version
npm pkg get dependencies.next dependencies.react dependencies.@assistant-ui/react devDependencies.playwright devDependencies.vitest
npm run build
```

Expected: the recorded source SHA contains all code and screenshot changes, Node reports major version 22, and the production build succeeds.

- [ ] **Step 2: Write the final walkthrough**

Create `docs/meridian/ui-walkthrough.md` with these exact sections:

```markdown
# MERIDIAN UI Walkthrough
## Provenance
## Fixture boundaries and safety
## Keyboard walkthrough
## Responsive Activity walkthrough
## Dialog walkthrough
## Status and evidence walkthrough
## Width matrix
## Actual 200% browser zoom
## Checks performed
## Separate genuine demo acceptance
```

Under Provenance, record the source SHA from Step 1, branch, Ubuntu/Xvfb environment, runtime/package versions, and `npm run build` result. Embed all four relative screenshot paths with captions stating `offline synthetic fixture`. In the width matrix, report 320/768/1024/1440 results. In the zoom section, state that headed Chromium loaded a profile preference equivalent to 200% and report the measured DPR/inner width/visual scale; explicitly state that CSS zoom, device scale emulation, and CDP viewport emulation were not used. In the final section, state that authenticated genuine-demo rehearsal remains a separate acceptance step and was not performed.

- [ ] **Step 3: Check documentation accuracy and links**

Run:

```bash
test -f docs/meridian/evidence/ui-walkthrough/activity-1440.png
test -f docs/meridian/evidence/ui-walkthrough/activity-320.png
test -f docs/meridian/evidence/ui-walkthrough/review-320.png
test -f docs/meridian/evidence/ui-walkthrough/native-zoom-200.png
rg -n 'offline synthetic fixture|200%|320|768|1024|1440|separate acceptance|source SHA|npm run build' docs/meridian/ui-walkthrough.md
git diff --check
```

Expected: every evidence file exists, every required provenance/boundary phrase is present, and the diff is clean.

- [ ] **Step 4: Commit the walkthrough**

```bash
git add docs/meridian/ui-walkthrough.md
git commit -m "docs(ui): add sourced accessibility walkthrough"
```

---

### Task 5: Independent review, complete gate, and scoped PR

**Files:**
- Review: all changes from `f4e48274f22a373982fdff6d4ffe6a2e93c69b25..HEAD`
- Create outside Git: `.superpowers/sdd/2026-09-08-ui-accessibility/spec-review.md`
- Create outside Git: `.superpowers/sdd/2026-09-08-ui-accessibility/quality-review.md`

**Interfaces:**
- Consumes: Tasks 1-4 as committed changes.
- Produces: independent spec verdict, independent quality verdict, clean complete verification, pushed branch, PR against `dev`, and hosted-CI status at the exact PR head.

- [ ] **Step 1: Run an independent spec review**

Give a fresh Luna/xhigh reviewer the transfer spec, the immutable dependency SHA, the full diff, and the constraints. Require a requirement-by-requirement `PASS` or actionable finding with file and line, including no server/storage scope, no sensitive request from navigation, actual-vs-emulated zoom distinction, screenshot provenance, and separate demo acceptance. Save the verdict to `.superpowers/sdd/2026-09-08-ui-accessibility/spec-review.md`.

- [ ] **Step 2: Run an independent code-quality review**

After spec compliance passes, give a different fresh Luna/xhigh reviewer the same committed range. Require review of focus timing, DOM stability, scroll restoration, request assertions, responsive breakpoints, native-profile cleanup, test determinism, and preservation of saved-conversation behavior. Save the verdict to `.superpowers/sdd/2026-09-08-ui-accessibility/quality-review.md`.

- [ ] **Step 3: Resolve findings with TDD and repeat both gates**

For every valid finding, add or tighten the failing test, reproduce it, make the smallest client-side fix, rerun the focused test, commit, and ask the applicable reviewer to re-check. Proceed only when both verdicts say `READY` with no blockers.

- [ ] **Step 4: Run the complete local gate on the final SHA**

Run serially:

```bash
npm run test:smoke
npm run ci
npm run build
xvfb-run -a env MERIDIAN_NATIVE_ZOOM=1 npx vitest run test/chat-ui.test.ts -t 'actual Chromium browser zoom at 200%'
git diff --check
git status --short
```

Expected: smoke, complete CI, production build, and native-zoom test all PASS; diff check is silent; worktree is clean.

- [ ] **Step 5: Push and open the scoped pull request**

```bash
git push -u origin codex/meridian-ui-accessibility
gh pr create --base dev --head codex/meridian-ui-accessibility \
  --title "feat(ui): complete accessibility and responsive walkthrough" \
  --body-file /tmp/meridian-ui-accessibility-pr.md
```

The PR body must name dependency PR `#103` and base commit `f4e48274f22a373982fdff6d4ffe6a2e93c69b25`, summarize client-only files, list exact checks/results, link the walkthrough and screenshots, state that all browser evidence is offline/synthetic, and explicitly state no server/storage change, merge, deployment, protected-demo restart, live transaction, or genuine-demo rehearsal occurred.

- [ ] **Step 6: Verify hosted CI at the exact PR head**

Run:

```bash
head_sha=$(git rev-parse HEAD)
gh pr checks --watch
test "$(gh pr view --json headRefOid --jq .headRefOid)" = "$head_sha"
```

Expected: required hosted checks PASS and the PR head exactly equals the locally verified SHA. Do not merge the PR.
