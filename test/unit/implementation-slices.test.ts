import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "node:test";
import { ImplementationSlices, sliceCapabilityCeiling, type SliceSpec, type SliceReceipt } from "../../src/workflows/implementation-slices.ts";
import { runWorkflowScript, type WorkflowScriptChildResult } from "../../src/workflows/scripted-workflow.ts";
import { sourceSlicePaths, sourceSliceToolDenial } from "../../src/runs/shared/source-slice-policy.ts";
import { formatSliceReviewTask } from "../../src/workflows/slice-briefs.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function fixture() {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "implementation-slice-")));
	dirs.push(dir);
	const file = path.join(dir, "source.ts");
	fs.writeFileSync(file, "// seed\n");
	let now = 0;
	const context = { artifactsDir: path.join(dir, "private"), cwd: dir, workflowRunId: "workflow-one" };
	const store = new ImplementationSlices(context, () => now, () => now);
	const spec: SliceSpec = { key: "parser", deliverable: "One parser helper", paths: [file], inputs: [], dependencies: [], criteria: "Export parse", validationScope: "source-only", writer: { agent: "worker", timeoutMs: 5000 }, reviewer: { agent: "reviewer", timeoutMs: 5000 }, firstProgressMs: 1000, checkpointIntervalMs: 1000 };
	return { dir, file, context, store, spec, time: (n: number) => { now = n; } };
}
function result(key = "parser.writer", more: Partial<WorkflowScriptChildResult> = {}): WorkflowScriptChildResult {
	return { key, runId: key + "-run", ok: true, output: "done", artifactPaths: [], structuredOutput: { status: "complete", summary: "Implemented parser", validation: "static" }, ...more };
}
function review(revision: string): WorkflowScriptChildResult { return result("parser.review", { structuredOutput: { verdict: "approved", revision, findings: "" } }); }
function implement(f: ReturnType<typeof fixture>) {
	const begin = f.store.begin(f.spec);
	f.time(100);
	fs.writeFileSync(f.file, "export const parse = (s: string) => s;\n");
	f.store.tick(begin.attempt);
	return { begin, sealed: f.store.seal(begin.attempt, result()) };
}

test("optional parent brief is bounded, explicit, and preserved without inventing context", () => {
	for (const brief of [null, [], "context", { extra: "unknown" }, { steps: 1 }, { context: "" }, { decisions: "   " }, { edgeCases: "a\u0000b" }, { context: "a".repeat(8193) }, { steps: "😀".repeat(2049) }]) {
		const f = fixture();
		assert.throws(() => f.store.begin({ ...f.spec, brief }), /brief|Unsupported slice field/);
		assert.equal(fs.existsSync(f.store.root), false);
	}
	const f = fixture();
	const brief = { context: "Caller requires a pure helper", decisions: "Keep the public signature", steps: "Inspect parser, then implement", edgeCases: "Reject empty header" };
	const start = f.store.begin({ ...f.spec, brief });
	assert.deepEqual(start.spec.brief, brief);
	const task = f.store.writerTask(start.attempt);
	for (const value of Object.values(brief)) assert.equal(task.split(value).length - 1, 1);
	assert.match(task, /do not expand this role's authority/);
	const g = fixture(), minimal = g.store.begin(g.spec);
	assert.equal(minimal.spec.brief, undefined);
	assert.match(g.store.writerTask(minimal.attempt), /No additional parent context supplied/);
	const h = fixture();
	assert.deepEqual(h.store.begin({ ...h.spec, brief: {} }).spec.brief, {});
	const boundary = fixture();
	assert.equal(boundary.store.begin({ ...boundary.spec, brief: { context: "a".repeat(8192) } }).spec.brief!.context!.length, 8192);
});

test("writer brief preserves successor decision, actual budgets, and paths outside cwd", () => {
	const f = fixture(), start = f.store.begin(f.spec);
	f.store.abandon("prior incomplete attempt");
	const cwd = path.join(f.dir, "different-working-directory");
	const next = new ImplementationSlices({ ...f.context, cwd, workflowRunId: "next" });
	const successorOf = { attempt: start.attempt, decision: "Implement only the header branch; prior writer closure reconciled" };
	const continued = next.begin({ ...f.spec, successorOf, writer: { ...f.spec.writer!, toolBudget: { hard: 30, soft: 20, block: "*" } } });
	const task = next.writerTask(continued.attempt);
	for (const literal of [cwd, f.file, successorOf.attempt, successorOf.decision, "hard 30, soft 20", "1000 ms", "5000 ms"]) assert.ok(task.includes(literal), literal);
	assert.match(task, /absolute paths.*may be outside cwd/);
	assert.match(task, /asking does not pause or extend/i);
	assert.match(task, /preserve current source and return status "incomplete"/);
});

test("review formatter refuses missing snapshots rather than falling back to moving source", () => {
	const common = { revision: "a".repeat(64), deliverable: "parser", criteria: "pure", timeoutMs: 5000, writer: undefined };
	for (const frozen of [[], [{ path: "/source.ts", sha256: "b".repeat(64), bytes: 4 }], [{ path: "/source.ts", snapshot: "/source.ts", sha256: "b".repeat(64), bytes: 4 }], [{ path: "/source.ts", snapshot: "/frozen.ts", sha256: null, bytes: 4 }]]) {
		assert.throws(() => formatSliceReviewTask({ ...common, frozen }), /requires frozen snapshot/);
	}
});

test("no deliverable and status-only notes cannot masquerade as implementation", () => {
	const f = fixture(), start = f.store.begin(f.spec);
	f.time(900); f.store.note(start.attempt, "INCOMPLETE: still reading");
	f.time(1001); assert.match(f.store.tick(start.attempt)!, /progress bound/);
	const terminal = f.store.seal(start.attempt, result());
	assert.equal(terminal.state, "blocked");
	assert.ok(terminal.errors.some((error) => error.includes("no new deliverable")));
	assert.deepEqual(terminal.checkpoints.map((cp) => cp.kind), ["baseline", "status", "handoff"]);
});

test("partial source followed by timeout preserves baseline, source and failed task despite runner exit0", () => {
	const f = fixture(), start = f.store.begin(f.spec);
	f.time(100); fs.writeFileSync(f.file, "partial source"); f.store.tick(start.attempt);
	f.time(1200);
	const terminal = f.store.seal(start.attempt, result(undefined, { ok: false, error: "task timed out", results: [{ exitCode: 0, error: "task timed out" }] as never }));
	assert.equal(terminal.state, "blocked");
	assert.equal((terminal.writer as { taskOk: boolean }).taskOk, false);
	const source = terminal.checkpoints.find((cp) => cp.kind === "source")!;
	assert.equal(fs.readFileSync(source.files![0]!.snapshot!, "utf8"), "partial source");
	assert.equal(fs.readFileSync(terminal.checkpoints[0]!.files![0]!.snapshot!, "utf8"), "// seed\n");
	assert.ok(fs.existsSync(path.join(terminal.artifactDirectory, "terminal.json")));
});

test("new bytes arriving after the early deadline are retained but not accepted", () => {
	const f = fixture(), start = f.store.begin(f.spec);
	f.time(1001); fs.writeFileSync(f.file, "late source");
	assert.match(f.store.tick(start.attempt)!, /progress bound/);
	assert.equal(f.store.seal(start.attempt, result()).state, "blocked");
});

test("abandonment finalizes exhausted and already-blocked attempts without overwriting evidence", () => {
	for (const exhausted of [true, false]) {
		const f = fixture(), start = f.store.begin(f.spec);
		if (exhausted) {
			for (let i = 1; i <= 63; i++) { f.time(i); fs.writeFileSync(f.file, `increment-${i}`); f.store.tick(start.attempt); }
		} else { f.time(1001); f.store.tick(start.attempt); }
		assert.deepEqual(f.store.abandon("outer timeout"), []);
		const terminalPath = path.join(start.artifactDirectory, "terminal.json");
		const bytes = fs.readFileSync(terminalPath, "utf8");
		const terminal = JSON.parse(bytes) as SliceReceipt;
		assert.equal(terminal.state, "blocked");
		assert.ok(terminal.errors.includes("outer timeout"));
		assert.ok(terminal.errors.some((error) => error.includes(exhausted ? "checkpoint budget" : "progress bound")));
		f.store.abandon("second termination");
		assert.equal(fs.readFileSync(terminalPath, "utf8"), bytes);
		const next = new ImplementationSlices({ ...f.context, workflowRunId: "successor" });
		assert.equal(next.begin({ ...f.spec, successorOf: { attempt: start.attempt, decision: "Reconciled prior process; explicitly selected smaller successor" } }).state, "writing");
	}
});

test("wall clock corrections do not change monotonic progress bounds", () => {
	const f = fixture();
	let wall = 50000, mono = 0;
	const store = new ImplementationSlices(f.context, () => wall, () => mono);
	const start = store.begin(f.spec);
	wall += 1000000; mono = 100;
	assert.equal(store.tick(start.attempt), undefined);
	wall -= 2000000; mono = 1001;
	assert.match(store.tick(start.attempt)!, /progress bound/);
	store.abandon("stop");
});

test("replaying previously seen revisions does not reset progress", () => {
	const f = fixture(), start = f.store.begin(f.spec);
	f.time(100); fs.writeFileSync(f.file, "one"); f.store.tick(start.attempt);
	f.time(500); fs.writeFileSync(f.file, "// seed\n"); f.store.tick(start.attempt);
	f.time(900); fs.writeFileSync(f.file, "one"); f.store.tick(start.attempt);
	f.time(1101); assert.match(f.store.tick(start.attempt)!, /progress bound/);
});

test("missing/malformed writer output and contradictory nested task status fail closed", () => {
	for (const bad of [undefined, null, "done", {}, { status: "complete" }, { status: "complete", summary: "ran compile", validation: "executed" }]) {
		const f = fixture(), start = f.store.begin(f.spec);
		fs.writeFileSync(f.file, "source");
		assert.equal(f.store.seal(start.attempt, result(undefined, { structuredOutput: bad })).state, "blocked");
	}
	const f = fixture(), start = f.store.begin(f.spec);
	fs.writeFileSync(f.file, "source");
	assert.equal(f.store.seal(start.attempt, result(undefined, { results: [{ exitCode: 0, error: "timed out" }] as never })).state, "blocked");
});

test("review uses frozen bytes, not the writer target; parent acceptance is distinct", () => {
	const f = fixture(), { sealed } = implement(f);
	assert.equal(sealed.state, "review-required");
	fs.writeFileSync(f.file, "moving target changed");
	const frozen = sealed.checkpoints.at(-1)!.files![0]!;
	assert.match(sealed.reviewTask!, new RegExp(sealed.revision!));
	assert.ok(sealed.reviewTask!.includes(frozen.snapshot!));
	assert.match(fs.readFileSync(frozen.snapshot!, "utf8"), /export const parse/);
	const reviewed = f.store.reviewed(sealed.attempt, review(sealed.revision!));
	assert.equal(reviewed.state, "parent-decision");
	assert.equal(reviewed.acceptance, undefined);
	assert.throws(() => f.store.accept(sealed.attempt, sealed.revision!, "accept"), /separate workflow/);
	const next = new ImplementationSlices({ ...f.context, workflowRunId: "parent-decision-workflow" });
	const accepted = next.accept(sealed.attempt, sealed.revision!, "Independently examined findings and source");
	assert.equal(accepted.acceptance?.revision, sealed.revision);
	const successor = next.begin({ ...f.spec, key: "next", dependencies: [{ attempt: sealed.attempt, revision: sealed.revision }] });
	assert.equal(successor.state, "writing");
	assert.throws(() => next.accept(sealed.attempt, sealed.revision!, "duplicate"), /EEXIST/);
});

test("blocked, missing, malformed, wrong revision and infrastructure-failed review stop dependencies", () => {
	for (const candidate of [undefined, {}, { verdict: "blocked", revision: "x", findings: "bug" }, { verdict: "approved", revision: "wrong", findings: "" }]) {
		const f = fixture(), { sealed } = implement(f);
		assert.equal(f.store.reviewed(sealed.attempt, candidate === undefined ? undefined : result("parser.review", { structuredOutput: candidate })).state, "blocked");
		assert.throws(() => f.store.assertLaunch("dependent.writer"), /parent decision/);
		const next = new ImplementationSlices({ ...f.context, workflowRunId: "next" });
		assert.throws(() => next.begin({ ...f.spec, dependencies: [{ attempt: sealed.attempt, revision: sealed.revision }] }), /ENOENT/);
	}
	const f = fixture(), { sealed } = implement(f);
	assert.equal(f.store.reviewed(sealed.attempt, { ...review(sealed.revision!), ok: false, error: "provider failed" }).state, "blocked");
});

test("tampering with frozen artifact blocks acceptance", () => {
	const f = fixture(), { sealed } = implement(f);
	f.store.reviewed(sealed.attempt, review(sealed.revision!));
	const file = sealed.checkpoints.at(-1)!.files![0]!.snapshot!;
	fs.chmodSync(file, 0o600); fs.writeFileSync(file, "tampered");
	const next = new ImplementationSlices({ ...f.context, workflowRunId: "next" });
	assert.throws(() => next.accept(sealed.attempt, sealed.revision!, "accept"), /changed before acceptance/);
});

test("parent contribution requires explicit authorization and pinned artifacts, then independent review", () => {
	const f = fixture();
	const sha256 = createHash("sha256").update(fs.readFileSync(f.file)).digest("hex");
	const { writer: _writer, ...spec } = f.spec;
	assert.throws(() => f.store.begin({ ...spec, parent: { artifacts: [{ path: f.file, sha256 }] } }), /authorization/);
	const begin = f.store.begin({ ...spec, parent: { authorization: "Owner authorized only this slice", artifacts: [{ path: f.file, sha256 }] } });
	assert.throws(() => f.store.writerTask(begin.attempt), /no writer assignment/);
	const sealed = f.store.seal(begin.attempt);
	assert.equal(sealed.state, "review-required");
	assert.equal(f.store.reviewed(begin.attempt, review(sealed.revision!)).state, "parent-decision");
});

test("non-Git cwd with private outputs reports scoped evidence, never no-mutation from failed Git", () => {
	const f = fixture();
	assert.equal(fs.existsSync(path.join(f.dir, ".git")), false);
	const { sealed } = implement(f);
	assert.match(sealed.mutationEvidence, /other mutations unknown; Git not inspected/);
	assert.equal(sealed.checkpoints.filter((cp) => cp.kind === "source").length, 1);
	// Fake the native harness's failed Git inspection: it cannot erase scoped bytes.
	const g = fixture(), start = g.store.begin(g.spec);
	fs.writeFileSync(g.file, "private artifact increment");
	const failed = g.store.seal(start.attempt, result(undefined, { ok: false, error: "Harness Git diff failed: not a git repository" }));
	assert.equal(failed.state, "blocked");
	assert.match(failed.mutationEvidence, /other mutations unknown/);
	assert.equal(fs.readFileSync(failed.checkpoints.find((cp) => cp.kind === "source")!.files![0]!.snapshot!, "utf8"), "private artifact increment");
});

test("bounds, pinned inputs, links and concurrent slices fail closed", () => {
	const f = fixture();
	assert.throws(() => f.store.begin({ ...f.spec, inputs: [{ path: f.file, sha256: "0".repeat(64) }] }), /identity mismatch/);
	assert.throws(() => f.store.begin({ ...f.spec, paths: [f.file, f.file] }), /Duplicate/);
	assert.throws(() => f.store.begin({ ...f.spec, validationScope: "AST regex allows compile" }), /source-only/);
	f.store.begin(f.spec);
	assert.throws(() => f.store.begin({ ...f.spec, key: "other" }), /active slice/);
});

test("source-only tool gate rejects execution, wrong paths and hardlinks; reviewer has no writes", () => {
	const f = fixture();
	for (const tool of ["bash", "powershell", "exec", "python", "subagent", "unknown_extension"]) assert.ok(sourceSliceToolDenial([f.file], f.dir, tool, { command: "compile('pass', '', 'exec')" }));
	assert.equal(sourceSliceToolDenial([f.file], f.dir, "write", { path: f.file }), undefined);
	assert.ok(sourceSliceToolDenial([], f.dir, "write", { path: f.file }));
	assert.ok(sourceSliceToolDenial([f.file], f.dir, "edit", { path: path.join(f.dir, "other") }));
	fs.linkSync(f.file, path.join(f.dir, "alias"));
	assert.ok(sourceSliceToolDenial([f.file], f.dir, "write", { path: f.file }));
	assert.equal(sliceCapabilityCeiling("reviewer").allowedTools?.includes("write"), false);
	assert.equal(sliceCapabilityCeiling("writer").denyExtensions, true);
	assert.deepEqual(sourceSlicePaths({ "pi-subagents.source-slice/1": { paths: [] } }), []);
});

test("workflow slice composes existing launch/result contract and blocks unaccepted follow-on", async () => {
	const f = fixture(), calls: string[] = [];
	const input = path.join(f.dir, "input-contract.md");
	fs.writeFileSync(input, "The parser must remain pure.");
	const sha256 = createHash("sha256").update(fs.readFileSync(input)).digest("hex");
	f.spec.inputs = [{ path: input, sha256 }];
	f.spec.brief = { context: "Supports the approved header format", decisions: "No I/O", steps: "Implement the pure parse helper", edgeCases: "Empty input" };
	let reviewTask = "";
	const run = await runWorkflowScript({
		script: `const slice = await runs.slice(${JSON.stringify(f.spec)}); let blocked; try { await runs.run('next', {agent:'worker', task:'mutate'}); } catch { blocked = true; } return {slice, blocked};`,
		slices: f.context,
		async launch(key, params, _signal, admission) {
			calls.push(key);
			assert.equal(params.context, "fresh");
			assert.ok(params.extensionBindings);
			assert.equal(admission.sliceRole, key.endsWith("writer") ? "writer" : "reviewer");
			const task = String(params.task);
			for (const value of Object.values(f.spec.brief!)) assert.ok(task.includes(value));
			assert.match(task, /## Role and objective/);
			assert.match(task, /## Completion criteria\nExport parse/);
			assert.match(task, /No shell commands|No edits or writes, shell commands/);
			assert.match(task, /structured_output/);
			assert.match(task, /contact_supervisor/);
			if (key.endsWith("writer")) {
				for (const literal of [input, sha256, f.file, f.context.cwd, 'status ("complete" or "incomplete")', 'validation ("none" or "static")']) assert.ok(task.includes(literal));
				assert.match(task, /verified at admission; these are not frozen copies/);
				fs.writeFileSync(f.file, "new source"); return result(key);
			}
			reviewTask = task;
			assert.ok(!task.includes(input));
			assert.match(task, /Do not open the moving source checkout, input files/);
			assert.match(task, /not instructions for you to execute/);
			assert.match(task, /unverified claims/);
			assert.match(task, /return blocked rather than infer success/);
			assert.match(task, /timeout: 5000 ms/);
			assert.doesNotMatch(task, /any read-only context/);
			const revision = task.match(/revision ([a-f0-9]{64})/)![1]!;
			return review(revision);
		},
		async status(key) { return result(key); },
	});
	assert.deepEqual(calls, ["parser.writer", "parser.review"]);
	const receipt = (run.value as { slice: SliceReceipt }).slice;
	assert.equal(receipt.state, "parent-decision");
	for (const file of receipt.checkpoints.at(-1)!.files!) {
		assert.ok(reviewTask.includes(file.snapshot!));
		assert.ok(reviewTask.includes(file.sha256!));
	}
	assert.equal((run.value as { blocked: boolean }).blocked, true);
});

test("failed writer has one attempt, no automatic setup-abort resume or review", async () => {
	const f = fixture(), calls: string[] = [];
	const run = await runWorkflowScript({
		script: `return runs.slice(${JSON.stringify(f.spec)});`, slices: f.context,
		async launch(key) { calls.push(key); fs.writeFileSync(f.file, "partial"); return result(key, { ok: false, error: "This operation was aborted", results: [{ error: "This operation was aborted", usage: {} }] as never }); },
		async status(key) { return result(key); },
	});
	assert.deepEqual(calls, ["parser.writer"]);
	assert.equal((run.value as SliceReceipt).state, "blocked");
});

test("early progress watchdog cancels a fake silent provider without retry", async () => {
	const f = fixture();
	let calls = 0;
	const run = await runWorkflowScript({
		script: `return runs.slice(${JSON.stringify({ ...f.spec, firstProgressMs: 10 })});`, slices: f.context,
		async launch(key, _params, signal) {
			calls++;
			await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
			return result(key, { ok: false, error: "fake provider aborted" });
		},
		async status(key) { return result(key); },
		timeoutMs: 5000,
	});
	assert.equal(calls, 1);
	assert.equal((run.value as SliceReceipt).state, "blocked");
	assert.ok((run.value as SliceReceipt).errors.some((error) => error.includes("progress bound")));
});

test("outer timeout preserves partial snapshots even with no settled child result", async () => {
	const f = fixture();
	await assert.rejects(runWorkflowScript({
		script: `return runs.slice(${JSON.stringify(f.spec)});`, slices: f.context,
		async launch(key, _params, signal) {
			fs.writeFileSync(f.file, "partial before outer timeout");
			await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
			return result(key, { ok: false, error: "aborted" });
		},
		async status(key) { return result(key); },
		timeoutMs: 150,
	}), /timed out/);
	const root = path.join(f.context.artifactsDir, "implementation-slices");
	const attempt = fs.readdirSync(root)[0]!;
	const terminal = JSON.parse(fs.readFileSync(path.join(root, attempt, "terminal.json"), "utf8")) as SliceReceipt;
	assert.equal(terminal.state, "blocked");
	assert.equal(fs.readFileSync(terminal.checkpoints.at(-1)!.files![0]!.snapshot!, "utf8"), "partial before outer timeout");
});

test("progress abort then outer timeout before child settlement still permits explicit recovery", async () => {
	const f = fixture();
	let aborted = false;
	await assert.rejects(runWorkflowScript({
		script: `return runs.slice(${JSON.stringify({ ...f.spec, firstProgressMs: 10 })});`, slices: f.context,
		async launch(_key, _params, signal) {
			signal.addEventListener("abort", () => { aborted = true; }, { once: true });
			return new Promise<WorkflowScriptChildResult>(() => {}); // deliberately uncooperative fake, no process
		},
		async status(key) { return result(key); }, timeoutMs: 1200,
	}), /timed out/);
	assert.equal(aborted, true);
	const root = path.join(f.context.artifactsDir, "implementation-slices");
	const id = fs.readdirSync(root)[0]!;
	const terminal = JSON.parse(fs.readFileSync(path.join(root, id, "terminal.json"), "utf8")) as SliceReceipt;
	assert.equal(terminal.state, "blocked");
	assert.ok(terminal.errors.some((error) => error.includes("progress bound")));
});

test("parent-produced workflow launches only an independent reviewer", async () => {
	const f = fixture(), calls: string[] = [];
	const { writer: _writer, ...spec } = f.spec;
	const parent = { authorization: "Owner approved parent source implementation", artifacts: [{ path: f.file, sha256: createHash("sha256").update(fs.readFileSync(f.file)).digest("hex") }] };
	const run = await runWorkflowScript({
		script: `return runs.slice(${JSON.stringify({ ...spec, parent })});`, slices: f.context,
		async launch(key, params) { calls.push(key); return review(String(params.task).match(/revision ([a-f0-9]{64})/)![1]!); },
		async status(key) { return result(key); },
	});
	assert.deepEqual(calls, ["parser.review"]);
	assert.equal((run.value as SliceReceipt).state, "parent-decision");
});
