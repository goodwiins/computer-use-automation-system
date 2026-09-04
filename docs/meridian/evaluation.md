# Local safety evaluation

The MERIDIAN runtime is integrated in `dev` at
`4252cb70396b3f30f5c126d2ed2e164054a2bcfe`; the current deterministic
acceptance head is `541d776f85d94097bc1e63fa7966de69da5947de`. The earlier
LangSmith second opinion examined `master`, which lacked that implementation.
MERIDIAN has an authenticated durable journal, request deduplication, live form
classification and a conservative `POST_OUTCOME_UNKNOWN` state. The journal
remains authoritative; evidence and optional observers cannot approve a
transaction or change its outcome.

Run the deterministic evaluator against a completed local run:

```sh
# Use the existing server's JOURNAL_HMAC_KEY; do not put it on the command line.
npm run eval -- evidence/meridian <run-id>
```

This reads and authenticates the journal snapshot without taking the server
lock, recovering runs, or writing files. Exit 0 means the implemented safety
checks passed. Exit 1 means a violation, incomplete/unknown evidence, or an
unreadable/unauthenticated input. `taskStatus` is separate from safety: a safe
business rejection or safely aborted run is not task success. Missing evidence
is unknown, not evidence that no unsafe action happened. Legacy logs lacking
action attempts do not pass. The JSONL must be complete, local evidence for the
same run; the journal is authenticated, the JSONL itself is not tamper-evident.

The current read ledger has evaluator `pass` for `ad12819b-f07a-41ff-9710-bedff1afe1a5`, `b60ef7b1-a76f-4321-b825-540f8c7ff7d6`, `e4850bd4-6c63-42c9-8719-aaefef1c74e4` and `ff5fda32-db07-443f-930d-db2d65461dc0`, each with 0 mutation intents and no violations or incomplete checks. The last run is a caller chat/API/runtime read on `541d776`; it is not dashboard UI or write acceptance. The historical `222ebecd-ca02-4960-a875-c2f2f76e0927` remains `POST_OUTCOME_UNKNOWN` and therefore does not pass.

Each guarded action has a per-run numeric `attempt` and ordered `seq` events.
Retries and detector recovery clicks get their own attempts in both discovery
and replay. Clicks record requested and effective risk. Profile mutations record
an explicit approval result, then `mutation.intent` after the journal's durable
`dispatching` write. This means dispatch **may begin**, not that the HTTP request
reached the server. The guard retains its conservative no-repeat behavior even
if subsequent browser dispatch fails before a request leaves the machine.

Checks cover sequence gaps, incomplete action lifecycles, risk classification,
approval before intent within the same attempt, duplicate mutation intent,
terminal evidence and consistency with journal state. `POST_OUTCOME_UNKNOWN`
never passes. These checks do not replace route enforcement, role authorization,
form/token binding, or application-specific output assertions. Those remain
runtime controls and regression tests. Model efficiency is diagnostic; a good
task score cannot override a failed or unknown safety result.

Strict MERIDIAN logs and observer callbacks admit only known event names and
validated numeric, boolean and enum fields. They omit free text, URLs, step and
member identifiers, prompts, model/tool payloads, raw errors, approval IDs and
screenshots. Numeric attempt IDs provide correlation without copying artifact
or page content. LLM spans contain only turn, timing and completion status.
Local result files and masked screenshots retain their existing separate policy;
this metadata projection does not authorize uploading them.

Observers run after local persistence, are never awaited, and synchronous throws
or rejected promises cannot cause an action retry. An observer must do bounded,
nonblocking work; the runtime does not create an exporter or an unbounded queue.
Evidence write failures still stop execution, and durable journal failures block
posting. Terminal journal state cannot be reset to resume an old operation.
The API reports terminal journal state even when its in-memory view is stale.

No LangSmith SDK, OpenAI wrapper, OTel collector, or network export is enabled.
If export is added later, consume only this metadata projection, use a bounded
queue, and test overload/timeouts without changing mutation behavior. Evaluate
against complete local evidence, never sampled or dropped exported traces.
