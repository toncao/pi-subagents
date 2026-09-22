# Failure-investigation implementation map

This document maps the seven findings in the private failure investigation to the
current fork after synchronizing with upstream `main`. It intentionally contains
no account identifiers, credentials, request payloads, or machine-local paths.

## Safety boundary

Validation is synthetic and offline (`PI_OFFLINE=1`, temporary test roots, and fake
child/provider responses in the selected suites). The inherited process environment
was not comprehensively scrubbed, so this is not evidence of credential isolation.
No credential rotation, account-order change, live inference, or provider health
probe is part of this change. A separate Pi repository validation
ran a model-catalog hydration command that contacted public catalog endpoints; that
side effect is not evidence about this package or provider health and must not be
reported as an offline provider check.

## 1. Verify the route before spending

**Status: covered by upstream plus retained fork behavior.**

- `src/runs/shared/model-resolution.ts` resolves qualified models within the named
  provider, rejects unknown explicit/configured models, and verifies the child-reported
  response identity unless the exact alias was declared.
- `resolveSameModelAccountFallbacks()` keeps only configured, registry-resolved aliases
  for the exact same model and account-provider family. It rejects apparent equivalence
  such as `openai/...` to `azure-openai-responses/...`.
- `test/unit/model-resolution.test.ts` covers strict not-found behavior, provider
  containment, exact account aliases, and cross-provider rejection.

This does not claim that any live account is healthy or affordable.

## 2. Separate inactivity, deadlines, and partial progress

**Status: covered by upstream; regression evidence retained.**

- Run deadlines are monotonic through `deadlineAt` in foreground and detached paths.
- `src/runs/background/subagent-runner.ts` schedules the optional pre-deadline
  checkpoint steer independently of the terminal timeout.
- `src/runs/shared/mutation-evidence.ts` and timeout-recovery projections preserve
  partial output, current tool/path, session, transcript, artifacts, and tracked
  mutation evidence instead of treating timeout as no progress.
- `test/integration/deadline-checkpoint.test.ts` covers checkpoint delivery,
  completion-before-checkpoint, and too-late checkpoint suppression.

No automatic replay follows a deadline or timeout.

## 3. Fix root account/auth recovery separately

**Status: outside this package.**

Account authentication, quota continuation, slot migration, and failover exemptions
belong to the companion multi-account extension. This package consumes only its
registered provider/model catalog. This change does not edit credentials, account
order, or user settings and does not make live-auth claims.

## 4. Fail over before progress; continue post-tool work without replay

**Status: implemented in this fork.**

- `fallbackModels` remains accepted in agent frontmatter, runtime definitions,
  profiles, and `subagents.agentOverrides` as an ordered recovery policy.
- Before useful assistant output, tool history, accepted follow-up input, mutation
  evidence, cancellation, deadline, or budget exhaustion, terminal provider/model failures (including HTTP
  401) may start the original task in a new child attempt on the next configured
  candidate. All candidates share the original deadline and persist per-attempt
  model, error, exit, and usage evidence.
- Provider error envelopes retain their underlying error instead of being replaced
  by model-response verification, so authentication and transport failures remain
  classifiable.
- `src/runs/shared/model-resolution.ts` admits post-tool continuation only after a trusted
  terminal rate/quota error and a fully paired, successful tool-call history.
  Pending or failed tools, active tools, cancellation, exhausted budgets, structured
  output, different models, and different provider families veto it.
- `src/runs/shared/child-session.ts` switches the existing local Pi session with
  `persist: false`; the transcript, tool results, and counters remain in that session.
  Remote Herdr sessions fail closed because their bridge has no live-switch contract.
- `src/runs/foreground/execution.ts` and
  `src/runs/background/run-child-session.ts` send only the bounded continuation
  notice; they never replay the original `Task:`.
- Results persist `attemptedModels` and `modelAttempts` so zero-progress and failed
  account attempts remain distinct from terminal success.
- `test/integration/in-process-child.test.ts` proves ordered zero-progress HTTP 401/503
  fallback, usage-budget and mutation vetoes, no different-model replay after useful
  output or a completed tool, one-time mutation across foreground continuation, and
  retained tool results in the detached driver.
- `test/integration/async-execution.part-1.test.ts` proves detached zero-progress
  fallback and post-tool continuation propagation, effective thinking replacement,
  correct session identity boundaries, and durable attempt evidence.

## 5. Preserve the real child failure cause

**Status: covered by upstream; regression evidence retained.**

- `src/runs/background/process-terminal.ts` records bounded process-terminal evidence.
- `src/runs/background/stale-run-reconciler.ts` preserves existing terminal results,
  runner stderr diagnostics, per-child outcomes, and explicit root-failure precedence
  when repairing a stale run.
- `test/unit/stale-run-reconciler.test.ts` covers dead and unverifiable PIDs, startup
  crash diagnostics, concurrent/late persistence, and root-cause precedence.

The implementation reports observed exit/signal/error evidence. It does not infer OOM
or provider causes from silence.

## 6. Make output contracts fail closed

**Status: covered by upstream; validated after merge.**

- `src/runs/shared/structured-output.ts` requires the registered
  `structured_output` tool call and validates the captured value against the schema.
  Missing calls, malformed values, and required missing acceptance reports are errors.
- `src/workflows/scripted-workflow.ts` treats only
  `structuredOutput.verdict === "blocked"` as a blocking successful stage and installs
  an acceptance-recovery barrier that prevents later launches/state/host calls.
- Structured-schema branch diagnostics are deterministic and bounded by
  `test/unit/structured-output-validation.test.ts`; workflow and child contract tests
  cover missing output and blocked dependent stages.

Plain prose or JSON-looking assistant text is not accepted as structured output.

## 7. Make delivery operational

**Status: covered by upstream; validated after merge.**

- File-only outputs carry managed `outputReference`/`savedOutputPath` metadata through
  result files, workflow receipts, child summaries, and completion notifications.
- `src/runs/background/steering.ts` records bounded FIFO receipts and distinguishes
  queued, delivered, partial, terminal, and unavailable outcomes without sibling
  fallback.
- Result publication keeps indexed delivery demand until durable terminal publication;
  stale repair never overwrites an existing result.
- Regression coverage: `test/integration/result-publication.test.ts`,
  `test/integration/workflow-result-publication.test.ts`,
  `test/integration/acceptance-file-report.test.ts`,
  `test/integration/foreign-workflow-steering.test.ts`,
  `test/integration/workflow-steer-inbox.test.ts`, and `test/unit/steering.test.ts`.

## Validation performed

- TypeScript: `npm run typecheck`.
- Merge/slices focus: implementation slices, model resolution, fork context, child
  runtime config, and scripted workflow tests.
- Recovery focus: model resolution, agent override/frontmatter/profile loading,
  foreground child continuation, detached child driver, and async end-to-end
  continuation.
- Evidence/delivery focus: stale-run reconciliation, structured validation, steering,
  output/reference receipts, deadline checkpoints, result publication, workflow
  publication, and file-only acceptance reports.

All commands used temporary test roots and fake child/provider responses. Passing tests
prove the cited local contracts only; they do not prove live account health, provider
availability, or production notification delivery.
