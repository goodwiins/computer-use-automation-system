# MERIDIAN UI baseline — September 7, 2026

This baseline packages the Next.js chat demo from `dev` base `8950d772e515886800093ec79c44d5009bd16e67`. It pins Next.js `16.3.4`, assistant-ui React `0.15.18`, assistant-ui AI SDK adapter `0.0.4`, and AI SDK `7.0.93`.

Run `npm run build` to create the static export. Run `npm run serve -- --profile meridian` to build and serve the export and the existing Express API together.

## Authentication boundary

Local teller login is disabled by default. `LOCAL_TELLER_LOGIN=1` enables the private loopback demo: `/session/options` advertises the configured demo choices and same-origin `/session/teller` returns a process-lifetime caller token. It never returns either configured API token. The token remains caller-scoped, cannot submit decisions or select supervisor execution, and expires on restart. Operator selection still requires the configured operator API credential. Switching identity, disconnecting, or reloading clears the page session and chat. Do not enable local teller login on a shared or remotely exposed service.

Express remains authoritative for `/capabilities`, `/runs`, decisions, evidence, and chat. Automatic intent classification exposes no capability for conversation, only `run_status` for status, and approved caller capabilities for a fresh invocation. One request can invoke at most one distinct capability. Replay identity, approval, expiry, and unknown-outcome rules remain server-enforced.

## Published capability artifacts

The baseline inherits these four approved MERIDIAN artifacts from `dev` without modifying them:

- `meridian-sign-on@1.0.0`
- `meridian-member-inquiry@1.0.0`
- `meridian-member-record@1.0.0`
- `meridian-open-share@1.0.0`

## Evidence and integration boundary

**Live read evidence from the separate dirty demo:** the source checkout at `ddd6a8a07e02e67e89f9b39ae73db8ac599982d2` was kept dirty and read-only while this baseline was copied. Existing sanitized live read evidence remains in [live-evidence.md](live-evidence.md); this packaging task ran only local fixtures and performed no target action. Raw member facts are intentionally omitted here.

Member-name composition depends on the separate, unmerged PR93 change at `c7bba9ec497ac55c27d3a8718ce4db554e364a40`; its service, session, dashboard, and identity-test changes are excluded from this baseline.

B1 must integrate subject authentication at the existing HTTP and chat seams. Subject mode must disable `/session/teller`, preserve subject ownership of runs and history, and only demote chat authority; it must not move authorization, replay, approval, or target-role decisions into the client.

## Pending UX work

Role-aware teller and supervisor workspaces, member-name composition, persisted conversations, focused review navigation, plain-language operation states, improved approval facts and actions, responsive conversation return, and final write demonstrations remain pending. They are not implemented by this baseline.
