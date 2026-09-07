# Next chat demo publication implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish the already implemented Next.js, local teller login and automatic-intent chat UI as a tested PR against dev, without republishing the separate member identity change.

**Architecture:** Next.js exports static client assets, served by the existing Express API with exact bootstrap CSP hashes and an isolated asset snapshot per server. assistant-ui and Vercel AI SDK keep displaying authoritative server run state. Local teller login is an explicit legacy demo option; chat never gains operator or target-supervisor authority.

**Tech Stack:** Node 22, Next.js 16.3.4, React 19.2.8, assistant-ui 0.15.18, AI SDK 7.0.93, Express, Vitest and Playwright.

**Spec:** Approved unit 0 of `/Users/goodwiinz/.codex/visualizations/2026/09/03/01a0698c-1872-7691-80f9-d8b796814750/meridian-ux-workflow-plan.md`; this plan packages only the already implemented baseline. Remaining units are separate deliveries.

## Global constraints

- Target `dev` at `8950d772e515886800093ec79c44d5009bd16e67`; branch `codex/next-chat-demo-ui`.
- Preserve `/Users/goodwiinz/.codex/worktrees/interface-ai-local-teller-login` and its running service. Read files there; never edit, restart or invoke target operations there.
- Exclude PR93 `c7bba9ec497ac55c27d3a8718ce4db554e364a40`. No service/session/dashboard member-identity hunks or identity tests in this PR.
- Express remains authoritative. No backend framework migration, raw artifacts/evidence, real credentials, target writes or approval execution.
- Local teller login is opt-in and loopback/same-origin only. It returns an ephemeral caller token, never either configured API token. Operator login requires its configured credential; caller chat remains teller-scoped.
- Subject-auth integration is backend-owned in `08eec5d`; the eventual integration must disable local demo login under subject mode, preserve subject ownership and demote chat authority only. Do not copy unpublished backend work into this baseline.
- Run heavy suites serially. Preserve unknown posting outcomes, same-key reuse, refusal/expiry and stale-decision guards.
- User has already authorized clean commits, push and PR creation against dev. No repeated publication or visual-scope approval is required.

### Task 1: Package and verify the implemented UI baseline

**Files:** Copy only `.env.example`, `.gitignore`, `README.md`, `docs/meridian/runbook.md`, `package.json`, `package-lock.json`, `src/server/http.ts`, `src/server/chat.ts`, `src/server/ui/chat.tsx`, `src/server/ui/main.tsx`, `src/server/ui/style.css`, `src/server/ui/transport.ts`, `test/chat-ui.test.ts`, `test/chat.test.ts`, `test/history-structure.test.ts`, `test/meridian.test.ts`, `test/server-startup.test.ts`, `tsconfig.json`, `tsconfig.ui.json`, `next-env.d.ts`, `next.config.mjs`, `src/app/layout.tsx`, `src/app/page.tsx`. Delete the old `src/server/ui/index.html` and `vite.config.ts`. Add a dated `docs/meridian/ui-baseline.md` manifest and this plan.

**Interfaces:** Existing `/capabilities`, `/runs`, decision/evidence and chat routes remain in Express. `/session/options` and `/session/teller` are the additive opt-in demo login contract. `intent: 'auto'` selects conversation/status/invoke before capability exposure; at most one distinct capability invocation remains permitted per request. No new role or subject contract is introduced by this task.

- [x] Record clean base and run repository setup and baseline smoke gate:

```sh
git rev-parse HEAD
npm run setup
npm run test:smoke
```

- [x] Copy the whitelist from the served source using `pathlib`/`shutil.copy2`; remove the two obsolete Vite entry files. Do not copy `.env`, evidence, artifacts, service.ts, ui/session.tsx, ui/dashboard.tsx or test/member-identity.test.ts.

```python
from pathlib import Path
from shutil import copy2
source = Path('/Users/goodwiinz/.codex/worktrees/interface-ai-local-teller-login')
for name in whitelist:
    target = Path(name)
    target.parent.mkdir(parents=True, exist_ok=True)
    copy2(source / name, target)
for name in ['src/server/ui/index.html', 'vite.config.ts']:
    Path(name).unlink()
```

- [x] Remove exactly the PR93 additions from the two shared copied files: the test block beginning `it('shows linked identity only for the exact balance in this login` and ending before `it('normalizes transport authority`; the runbook paragraph beginning `A fresh successful member-record request also starts one approved member-inquiry read`. Preserve all other copied UI tests/docs. Confirm service.ts, ui/session.tsx and ui/dashboard.tsx have no diff from dev.

- [x] Verify the copied behavior with the existing meaningful tests. The local teller fixture must reject off-origin minting and deny decisions/supervisor invocation with the minted caller token. The browser fixture must require operator credentials for the operator choice and clear session/chat when switching/reloading. Automatic intent tests must keep status/greetings/ambiguous assent from authorizing fresh capability calls; backend replay and personal approval stay authoritative. Add the smallest missing boundary check only if inspection finds a gap.

```sh
npm run setup
npm test -- test/chat.test.ts test/chat-ui.test.ts test/server-startup.test.ts
npm test -- test/meridian.test.ts -t 'local teller'
```

- [x] Write `docs/meridian/ui-baseline.md` with date, base SHA, pinned Next/assistant-ui/AI SDK versions, build/serve commands, the opt-in demo authentication boundary, four approved artifacts inherited from dev, the unmerged PR93 dependency for name composition, and B1 http/chat integration requirements. Clearly label live read evidence from the separate dirty demo and omit raw member facts. List remaining UX plan items as pending, not implemented.

- [x] Inspect the full diff for unrelated files and accidental secrets. Run final gates once after all edits, then commit only scoped files:

```sh
npm run ci
git diff --check
git diff --stat
git add <explicit scoped files>
git commit -m 'Publish Next.js chat demo with local teller login and automatic intent'
```

- [x] Write a report in this plan's SDD workspace with base/head, copied/changed files, test commands/results, source preservation evidence and any concerns. Do not push; the coordinator owns independent review, push/PR and exact-head hosted checks.

## Delivery gates

- [ ] Independent task/quality review and final branch review completed; material findings fixed and checked.
- [ ] Push and open PR against dev, documenting that PR93 is separate and B1 must integrate the http/chat/auth seams.
- [ ] Exact-head hosted CI is terminal and successful.
- [ ] Send the demo and backend tasks the actual PR title/URL/head, test evidence and remaining plan boundary.
