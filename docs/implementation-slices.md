# Persisted source implementation slices

`runs.slice(spec)` is an opt-in helper **inside `workflowScript`**, not a new
runner or a general project manager. Use it for one small coherent source
increment when an assignment has become too large to complete reliably. Keep
ordinary `runs.run` for small tasks that do not need this evidence protocol.

The first version deliberately supports **source-only** work, 1–8 explicitly
named regular files (up to 1 MiB each), and one slice per workflow. It does not
apply patches, commit, publish, execute validation, or authorize live work.

## Contract and example

```js
subagent({ async: true, workflowScript: `
  return await runs.slice({
    key: "parse-header",
    deliverable: "Implement the pure header parser only",
    paths: ["/work/project/src/header.ts"],
    inputs: [
      { path: "/work/project/docs/header-format.md", sha256: "<64 hex characters>" }
    ],
    dependencies: [],
    criteria: "Export parseHeader; reject missing delimiters; no I/O",
    brief: {
      context: "The caller needs a pure parser before its I/O integration is changed.",
      decisions: "Keep the existing exported signature. Do not change callers.",
      steps: "Read the pinned format, inspect the existing parser, then implement only delimiter handling.",
      edgeCases: "Missing delimiter, empty header, and additional delimiters in the value."
    },
    validationScope: "source-only",
    writer: { agent: "worker", timeoutMs: 240000 },
    reviewer: { agent: "reviewer", timeoutMs: 180000 },
    firstProgressMs: 60000,
    checkpointIntervalMs: 60000
  });
` });
```

`paths` is both the exact permitted mutation inventory and the deliverable
inventory: no globs, directories, or scratch/status files. `inputs` pins required
input bytes; `dependencies` identifies previously accepted slice revisions.
Each dependency is `{ attempt, revision }`, using the returned attempt UUID and
revision SHA-256. Input hashes are checked before launch. The parent is
responsible for choosing a coherent deliverable and sufficient criteria; the
harness cannot infer a useful split from a large assignment.

### Readable child assignments

Optional `brief` fields are `context`, `decisions`, `steps`, and `edgeCases`.
Each supplied field must be a nonempty string of at most 8192 UTF-8 bytes, without
NUL characters; unknown fields are rejected. Omit the object or individual fields
when unnecessary. Existing slice contracts without `brief` remain valid.

The parent supplies task-specific facts and guidance. A shared formatter turns
the validated contract into headed writer/reviewer assignments covering objective,
context, files, steps, criteria, permissions, validation, budgets, output, and
escalation. It explicitly identifies missing context rather than inventing it.
Parent suggestions cannot widen permissions, change the exact mutation inventory,
or authorize execution. Ordinary `runs.run` task strings are unchanged.

Writers see the actual cwd, absolute editable paths (which may be outside cwd),
read-only input pins, dependencies, explicit successor decisions, and progress
limits. Input hashes were checked at admission; the input paths are not frozen
copies. Reviewers instead receive exact frozen snapshot paths/hashes, inline
requirements, and labeled unverified writer claims. Implementation steps are
context for review, not instructions to edit. Reviewers must not fetch moving
source/input files to fill gaps; an unprovable required criterion blocks approval.

Both roles get explicit structured-output keys and escalation guidance. A question
to `contact_supervisor` should identify the evidence, saved work, exact decision
needed, and recommendation. Asking does not pause budgets or widen authority; if
unresolved within budget, hand back incomplete work or a blocked review.

The helper composes the existing keyed native child launches with fresh contexts,
managed outputs, schema-validated handoffs, normal runtime deadlines, inherited
workflow usage budgets, and normal configured model/provider selection. It does
not select another model or runner. Optional writer `toolBudget` requires
`block: "*"`; hard limits that only block discovery tools are inappropriate here.
Usage budgets remain reported-usage admission limits, not instantaneous spend
limits. Set a workflow timeout with margin for writer, reviewer, and persistence.

## Evidence, not activity

The host takes a baseline before launch. During the writer it samples only the
specified files once per second and saves changed revisions under the existing
artifact root:

```text
implementation-slices/<attempt>/
  checkpoint-0/...
  checkpoint-1/...
  <sequence>-<event-uuid>.json
  terminal.json
  accepted.json                 # only after a separate parent decision
```

Every event is a complete recovery record, created exclusively. Earlier events,
source copies, and failed attempts are not overwritten. The returned
`artifactDirectory` locates them. This first version does not automatically prune
slice directories; preserve or archive the evidence deliberately.

Checkpoints distinguish `baseline`, `source`, `status`, and `handoff`. A status
note, tool count, tokens, repeated bytes, or returning to a previously seen
revision does not advance the source-progress clock. Elapsed bounds use a
monotonic clock; checkpoint timestamps remain wall-clock evidence. A late revision is retained
but does not cure a missed progress deadline. Writer completion requires a
nonempty changed final deliverable and a structured `complete` handoff.

Writer validation is explicitly `none` or `static`. Static inspection is **not**
executed validation. This version refuses executable validation rather than
pretending a diagnostic compile is harmless. The review sees these validation
claims as claims; it is not a test receipt.

Sampling proves observed byte changes, not semantic usefulness. A writer putting
an INCOMPLETE note into a declared source file can change its bytes; only the
independent review against the completion criteria can determine whether that
is implementation. Files changed and reverted between samples may be missed.
Sixty-four checkpoint entries bound each attempt. A capture or persistence error
blocks the slice. Source files are copied independently, not as an atomic
multi-file filesystem transaction.

## Independent review and parent acceptance

The writer settles before the reviewer starts. The reviewer receives copies from
the final persisted checkpoint and its revision hash, **not a moving source
checkout**. Its schema must return exactly:

```json
{ "verdict": "approved", "revision": "<exact revision>", "findings": "..." }
```

Missing/malformed output, a blocked verdict, a failed task, a detached/stopped
child, a mismatched revision, or changed frozen bytes blocks the slice. Native
`ok:true`, exit0, output existence, and prose are not review approval. The helper
returns `parent-decision`, never automatic acceptance. Further child launches in
that workflow are blocked, including a retry of the writer under another key.

After examining the source and findings, the parent may run a **separate**
workflow against the same artifact root:

```js
subagent({ async: true, workflowScript: `
  return await runs.acceptSlice(
    "<attempt UUID>", "<revision SHA-256>",
    "Accepted after examining the frozen source and disposing of review findings"
  );
` });
```

Acceptance rechecks frozen file hashes and writes an exclusive `accepted.json`.
A later slice lists that exact pair in `dependencies`. Acceptance is an explicit
controller attestation, not a human authentication mechanism. Neither acceptance
nor an approved review proves the working checkout still matches the frozen
revision. Pin/check the intended current inputs before the next change.

## Failure and parent-produced source

There is one writer attempt, not an automatic retry loop. The helper disables
the ordinary zero-usage setup-abort auto-resume for its children. Configured
provider/model fallbacks still follow the native launch contract. No CLI,
foreground, shell-driven agent, or alternate execution mode is launched.

After failure, inspect the attempt's retained artifacts plus native run status,
workflow receipt, and process-terminal proof. Task result, runner closure,
artifact persistence, review verdict, and parent acceptance remain separate.
A runner exit0 never clears a task timeout. An abandoned attempt stays blocked
with its previous checkpoints available. Workflow termination finalizes an
already-progress-blocked attempt even when a final source capture fails or the
checkpoint budget is exhausted. Terminal-persistence failures are surfaced, not
silently treated as success. Abrupt host death can leave a last
`writing` checkpoint; that is historical evidence, not proof of a live process.

The parent must reconcile possible mutations and actual process closure before
selecting a smaller same-protocol successor. Start a new workflow and include
`successorOf: { attempt, decision }`; the decision explains the narrower scope
and reconciliation. This is an audit reference, not automatic retry authority.
Do not rerun the unchanged large assignment.

If the owner **explicitly authorized parent implementation for this task**, the
parent may implement outside the helper and replace `writer` with:

```js
parent: {
  authorization: "Reference to the owner's task-specific parent implementation approval",
  artifacts: [{ path: "/work/project/src/header.ts", sha256: "<exact current hash>" }]
}
```

The artifact paths must exactly match `paths`, in order. The helper verifies the
pins and launches only the independent reviewer. Parent-source submission does
not claim that the helper observed early implementation progress. An arbitrary
nonempty authorization reference records an attestation; the controller must
actually possess the authorization. It does not grant future blanket fallback
permission. The same separate parent acceptance step remains required.

## Enforcement and residual limits

- Source-slice native tool ceilings exclude bash, PowerShell, subagents, MCP, and
  arbitrary extension tools. Additional caller ceilings can only narrow them.
  A package-owned tool-call hook also denies non-allowlisted tools and limits
  `write`/`edit` to the declared exact paths. Reviewers have an empty mutation
  inventory. Links, hardlinks and non-regular mutation targets are refused.
- These are **same-process runtime controls**, not an OS sandbox. Trusted tool
  implementations, trusted host code, and path replacement races are outside
  the guarantee. The hook is not a shell regex. Read/search tools can inspect
  context, and their normal implementation may invoke search utilities; no
  model-controlled general executable tool is admitted.
- Ambient/configured provider extensions are suppressed by `denyExtensions` for
  these source-only children. A configuration that needs a child provider
  extension may consequently fail closed. Do not change authentication/model or
  permission configuration to work around that failure. Ordinary non-slice
  launches are unchanged.
- Child watchdog diagnostics are omitted for source-only slices, and the helper
  supplies no executable acceptance gate. Static review does not qualify source
  for compilation, imports, tests, native bootstrap, or live execution.
- One active slice is enforced **within a workflow**. The parent still owns the
  one-writer-per-cwd rule across workflows, other Pi sessions and external tools.
  Do not start overlapping slice workflows in a shared checkout. Managed
  worktree provisioning remains a separate existing facility; prepare an exact
  isolated target first rather than expecting this helper to relocate paths.
- No Git inspection is needed for this scoped evidence. In a non-Git cwd, or for
  private files outside a repo, changed declared bytes are still reported.
  `other mutations unknown; Git not inspected` means exactly that. A failed or
  empty Git diff elsewhere cannot establish absence of mutations, and the
  harness does not scan arbitrary directories to reconstruct them.

Existing `runs.run`, `runs.all`, `runs.lanes`, retained resume, supervisor control,
and workflow receipts retain their existing behavior when slices are not used.
This feature does not complete or qualify any application/serving-sizing work.
Source acceptance, synthetic qualification, native-bootstrap qualification,
actual execution, and live authorization remain separate decisions.
