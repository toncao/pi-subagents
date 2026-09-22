import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { WorkflowScriptChildResult } from "./scripted-workflow.ts";
import { formatSliceReviewTask, formatSliceWriterTask, SLICE_BRIEF_FIELDS, type SliceBriefInput } from "./slice-briefs.ts";
import type { ResolvedSubagentCapabilityCeiling } from "../runs/shared/capability-ceiling.ts";

const KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const ID = /^[a-f0-9-]{36}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_FILE = 1024 * 1024;
const MAX_FILES = 8;
const MAX_CHECKPOINTS = 64;
const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
function record(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown, label: string): string {
	if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > 8192 || value.includes("\0")) throw new Error(`Invalid slice ${label}.`);
	return value;
}
function fields(value: Record<string, unknown>, allowed: string[]): void {
	if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error("Unsupported slice field.");
}
function positive(value: unknown, label: string, max = 1_800_000): number {
	if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > max) throw new Error(`Invalid slice ${label}.`);
	return Number(value);
}

export interface SliceSpec {
	key: string;
	deliverable: string;
	paths: string[];
	inputs: Array<{ path: string; sha256: string }>;
	dependencies: Array<{ attempt: string; revision: string }>;
	criteria: string;
	validationScope: "source-only";
	writer?: { agent: string; timeoutMs: number; toolBudget?: { hard: number; soft?: number; block: "*" } };
	parent?: { authorization: string; artifacts: Array<{ path: string; sha256: string }> };
	reviewer: { agent: string; timeoutMs: number };
	firstProgressMs: number;
	checkpointIntervalMs: number;
	successorOf?: { attempt: string; decision: string };
	/** Optional parent-supplied bounded brief fields; never a substitute for the pinned spec. */
	brief?: SliceBriefInput;
}
interface FileEvidence { path: string; sha256: string | null; bytes: number; snapshot?: string }
interface Checkpoint {
	sequence: number; at: number; kind: "baseline" | "source" | "status" | "handoff";
	files?: FileEvidence[]; revision?: string; note?: string;
}
export interface SliceReceipt {
	version: 1; attempt: string; artifactDirectory: string; workflowRunId: string; spec: SliceSpec; startedAt: number;
	state: "writing" | "review-required" | "parent-decision" | "blocked";
	checkpoints: Checkpoint[]; errors: string[];
	mutationEvidence: "declared-files-only; other mutations unknown; Git not inspected";
	writer?: unknown; review?: unknown; revision?: string; reviewTask?: string;
	acceptance?: { workflowRunId: string; revision: string; reason: string };
}
interface ActiveSlice { receipt: SliceReceipt; lastProgressAt: number; seen: Set<string>; latest: FileEvidence[] }

/** Native launch restriction, not an OS sandbox or a shell-string classifier. */
export function sliceCapabilityCeiling(role: "writer" | "reviewer"): ResolvedSubagentCapabilityCeiling {
	return { version: 1, allowedTools: role === "writer" ? ["read", "grep", "find", "ls", "write", "edit"] : ["read", "grep", "find", "ls"], denyExtensions: true, sources: ["persisted-source-slice"] };
}
export const sliceWriterSchema = {
	type: "object", additionalProperties: false,
	properties: { status: { type: "string", enum: ["complete", "incomplete"] }, summary: { type: "string", minLength: 1 }, validation: { type: "string", enum: ["none", "static"] } },
	required: ["status", "summary", "validation"],
};
export const sliceReviewSchema = {
	type: "object", additionalProperties: false,
	properties: { verdict: { type: "string", enum: ["approved", "blocked"] }, revision: { type: "string" }, findings: { type: "string" } },
	required: ["verdict", "revision", "findings"],
};

/** A deliberately small evidence journal. It never starts a runner, retries, executes validation, or scans a tree. */
export class ImplementationSlices {
	private active = new Map<string, ActiveSlice>();
	private keys = new Set<string>();
	readonly root: string;
	readonly context: { artifactsDir: string; workflowRunId: string; cwd: string };
	private now: () => number;
	private monotonicNow: () => number;
	constructor(context: { artifactsDir: string; workflowRunId: string; cwd: string }, now = Date.now, monotonicNow = () => performance.now()) {
		this.context = context;
		this.now = now;
		this.monotonicNow = monotonicNow;
		this.root = path.join(context.artifactsDir, "implementation-slices");
	}
	private dir(id: string): string {
		if (!ID.test(id)) throw new Error("Invalid slice attempt identity.");
		return path.join(this.root, id);
	}
	private save(receipt: SliceReceipt): SliceReceipt {
		// Each event is a complete recovery checkpoint. Never rewrite a prior event.
		const dir = this.dir(receipt.attempt);
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		const entry = path.join(dir, `${String(receipt.checkpoints.length).padStart(3, "0")}-${randomUUID()}.json`);
		fs.writeFileSync(entry, JSON.stringify(receipt, null, 2), { flag: "wx", mode: 0o400 });
		return JSON.parse(JSON.stringify(receipt)) as SliceReceipt;
	}
	private fixed(id: string, name: string, value: unknown): void {
		fs.writeFileSync(path.join(this.dir(id), name), JSON.stringify(value, null, 2), { flag: "wx", mode: 0o400 });
	}
	private readFixed(id: string, name: string): SliceReceipt {
		const file = path.join(this.dir(id), name);
		const stat = fs.lstatSync(file);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new Error("Invalid slice receipt file.");
		const value = JSON.parse(fs.readFileSync(file, "utf8"));
		if (!record(value) || value.version !== 1 || value.attempt !== id) throw new Error("Invalid slice receipt identity.");
		return value as unknown as SliceReceipt;
	}
	private readFiles(paths: string[], snapshotDir?: string): FileEvidence[] {
		return paths.map((file, index) => {
			// Reject links, devices and directories; bound the actual read, not just stat size.
			try {
				if (fs.realpathSync(file) !== file) throw new Error("Slice paths must not contain symlinks.");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path: file, sha256: null, bytes: 0 };
				throw error;
			}
			const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
			try {
				const before = fs.fstatSync(fd);
				if (!before.isFile() || before.size > MAX_FILE) throw new Error("Slice artifacts must be regular files of at most 1 MiB.");
				const buffer = Buffer.alloc(MAX_FILE + 1);
				let size = 0;
				while (size < buffer.length) {
					const count = fs.readSync(fd, buffer, size, buffer.length - size, null);
					if (!count) break;
					size += count;
				}
				const after = fs.fstatSync(fd);
				if (size > MAX_FILE || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error("Slice artifact changed during capture.");
				const bytes = buffer.subarray(0, size);
				const snapshot = snapshotDir ? path.join(snapshotDir, `${index}-${path.basename(file)}`) : undefined;
				if (snapshot) fs.writeFileSync(snapshot, bytes, { flag: "wx", mode: 0o400 });
				return { path: file, sha256: digest(bytes), bytes: size, ...(snapshot ? { snapshot } : {}) };
			} finally { fs.closeSync(fd); }
		});
	}
	private revision(files: FileEvidence[]): string {
		return digest(JSON.stringify(files.map(({ path, sha256, bytes }) => ({ path, sha256, bytes }))));
	}
	private identities(value: unknown, label: string): Array<{ path: string; sha256: string }> {
		if (!Array.isArray(value) || value.length > MAX_FILES) throw new Error(`Invalid slice ${label}.`);
		return value.map((item) => {
			if (!record(item)) throw new Error(`Invalid slice ${label}.`);
			fields(item, ["path", "sha256"]);
			const file = this.exactPath(item.path);
			if (typeof item.sha256 !== "string" || !HASH.test(item.sha256)) throw new Error(`Invalid slice ${label} digest.`);
			return { path: file, sha256: item.sha256 };
		});
	}
	private exactPath(value: unknown): string {
		const file = text(value, "path");
		if (!path.isAbsolute(file) || path.normalize(file) !== file || /[\r\n]/.test(file)) throw new Error("Slice paths must be exact normalized absolute paths.");
		return file;
	}
	private verifyInputs(inputs: Array<{ path: string; sha256: string }>): void {
		const actual = this.readFiles(inputs.map((item) => item.path));
		if (inputs.some((item, index) => actual[index]?.sha256 !== item.sha256)) throw new Error("Slice input identity mismatch.");
	}
	begin(value: unknown): SliceReceipt {
		if (!record(value)) throw new Error("Slice contract must be an object.");
		fields(value, ["key", "deliverable", "paths", "inputs", "dependencies", "criteria", "validationScope", "writer", "parent", "reviewer", "firstProgressMs", "checkpointIntervalMs", "successorOf", "brief"]);
		if (typeof value.key !== "string" || !KEY.test(value.key) || this.keys.has(value.key)) throw new Error("Invalid or reused slice key; select an explicit successor instead of retrying unchanged work.");
		if ([...this.active.values()].some(({ receipt }) => receipt.state === "writing" || receipt.state === "review-required")) throw new Error("Only one active slice is allowed per workflow; do not share a writer target.");
		if (!Array.isArray(value.paths) || value.paths.length < 1 || value.paths.length > MAX_FILES) throw new Error("Slice requires 1-8 exact deliverable paths.");
		const paths = value.paths.map((file) => this.exactPath(file));
		if (new Set(paths).size !== paths.length || paths.some((file) => file === this.root || file.startsWith(this.root + path.sep))) throw new Error("Duplicate or journal-owned slice path.");
		if (value.validationScope !== "source-only") throw new Error("This slice supports source-only work; no executable validation.");
		if (!!value.writer === !!value.parent) throw new Error("Select one producer: writer or explicitly authorized parent.");
		const agent = (entry: unknown) => {
			if (!record(entry)) throw new Error("Invalid slice agent contract.");
			fields(entry, ["agent", "timeoutMs", "toolBudget"]);
			const parsed: NonNullable<SliceSpec["writer"]> = { agent: text(entry.agent, "agent"), timeoutMs: positive(entry.timeoutMs, "timeoutMs") };
			if (entry.toolBudget !== undefined) {
				if (!record(entry.toolBudget)) throw new Error("Invalid slice toolBudget.");
				fields(entry.toolBudget, ["hard", "soft", "block"]);
				if (entry.toolBudget.block !== "*") throw new Error("Slice hard tool budget must block '*', not just discovery tools.");
				parsed.toolBudget = { hard: positive(entry.toolBudget.hard, "toolBudget", 10000), block: "*" };
				if (entry.toolBudget.soft !== undefined) parsed.toolBudget.soft = positive(entry.toolBudget.soft, "soft toolBudget", parsed.toolBudget.hard);
			}
			return parsed;
		};
		const inputs = this.identities(value.inputs, "inputs");
		this.verifyInputs(inputs);
		if (!Array.isArray(value.dependencies) || value.dependencies.length > 16) throw new Error("Invalid slice dependencies.");
		const dependencies = value.dependencies.map((item) => {
			if (!record(item) || typeof item.attempt !== "string" || typeof item.revision !== "string") throw new Error("Invalid slice dependency.");
			fields(item, ["attempt", "revision"]);
			const accepted = this.readFixed(item.attempt, "accepted.json");
			if (accepted.acceptance?.revision !== item.revision) throw new Error("Slice dependency is not accepted at this revision.");
			return { attempt: item.attempt, revision: item.revision };
		});
		if (this.active.size > 0) throw new Error("Finish this workflow and make a separate parent decision before beginning another slice.");
		const spec: SliceSpec = { key: value.key, deliverable: text(value.deliverable, "deliverable"), paths, inputs, dependencies, criteria: text(value.criteria, "criteria"), validationScope: "source-only", reviewer: agent(value.reviewer), firstProgressMs: positive(value.firstProgressMs, "firstProgressMs"), checkpointIntervalMs: positive(value.checkpointIntervalMs, "checkpointIntervalMs") };
		if (value.brief !== undefined) {
			if (!record(value.brief)) throw new Error("Invalid slice brief.");
			fields(value.brief, [...SLICE_BRIEF_FIELDS]);
			const brief: SliceBriefInput = {};
			for (const name of SLICE_BRIEF_FIELDS) {
				const field = value.brief[name];
				if (field !== undefined) brief[name] = text(field, `brief ${name}`);
			}
			spec.brief = brief;
		}
		if (value.writer) {
			spec.writer = agent(value.writer);
			if (spec.firstProgressMs > spec.writer.timeoutMs || spec.checkpointIntervalMs > spec.writer.timeoutMs) throw new Error("Progress bounds must fit within writer runtime.");
		} else {
			if (!record(value.parent)) throw new Error("Invalid parent slice contribution.");
			fields(value.parent, ["authorization", "artifacts"]);
			spec.parent = { authorization: text(value.parent.authorization, "parent authorization reference"), artifacts: this.identities(value.parent.artifacts, "parent artifacts") };
			if (JSON.stringify(spec.parent.artifacts.map((item) => item.path)) !== JSON.stringify(paths)) throw new Error("Parent artifacts must exactly match slice paths in order.");
			this.verifyInputs(spec.parent.artifacts);
		}
		if (value.successorOf !== undefined) {
			if (!record(value.successorOf) || typeof value.successorOf.attempt !== "string") throw new Error("Invalid successor reference.");
			fields(value.successorOf, ["attempt", "decision"]);
			this.readFixed(value.successorOf.attempt, "terminal.json");
			spec.successorOf = { attempt: value.successorOf.attempt, decision: text(value.successorOf.decision, "successor decision") };
		}
		const attempt = randomUUID();
		const startedAt = this.now();
		const baseline = this.readFiles(paths);
		const receipt: SliceReceipt = { version: 1, attempt, artifactDirectory: this.dir(attempt), workflowRunId: this.context.workflowRunId, spec, startedAt, state: "writing", checkpoints: [], errors: [], mutationEvidence: "declared-files-only; other mutations unknown; Git not inspected" };
		this.keys.add(spec.key);
		this.active.set(attempt, { receipt, lastProgressAt: this.monotonicNow(), seen: new Set([this.revision(baseline)]), latest: baseline });
		fs.mkdirSync(this.dir(attempt), { recursive: true, mode: 0o700 });
		this.capture(attempt, "baseline");
		return this.save(receipt);
	}
	private get(id: string): ActiveSlice {
		const entry = this.active.get(id);
		if (!entry) throw new Error("Slice attempt is not owned by this workflow.");
		return entry;
	}
	private capture(id: string, kind: Checkpoint["kind"]): void {
		const entry = this.get(id), receipt = entry.receipt;
		if (receipt.checkpoints.length >= MAX_CHECKPOINTS) throw new Error("Slice checkpoint budget exhausted.");
		const dir = path.join(this.dir(id), `checkpoint-${receipt.checkpoints.length}`);
		fs.mkdirSync(dir, { mode: 0o700 });
		const files = this.readFiles(receipt.spec.paths, dir);
		const revision = this.revision(files);
		const at = this.now();
		receipt.checkpoints.push({ sequence: receipt.checkpoints.length, at, kind, files, revision });
		entry.latest = files;
		if (kind === "source" && !entry.seen.has(revision)) { entry.lastProgressAt = this.monotonicNow(); entry.seen.add(revision); }
		this.save(receipt);
	}
	/** Status notes never move the source progress clock. */
	note(id: string, note: string): SliceReceipt {
		const { receipt } = this.get(id);
		if (receipt.state !== "writing" || receipt.checkpoints.length >= MAX_CHECKPOINTS) throw new Error("Slice cannot accept another checkpoint.");
		receipt.checkpoints.push({ sequence: receipt.checkpoints.length, at: this.now(), kind: "status", note: text(note, "checkpoint note") });
		return this.save(receipt);
	}
	/** Called only while an opted-in writer is active, never by status rendering. */
	tick(id: string): string | undefined {
		const entry = this.get(id), receipt = entry.receipt;
		if (receipt.state !== "writing") return receipt.errors.at(-1);
		try {
			// Check expiry BEFORE crediting a late write. Notes/tokens/tools cannot extend it.
			const limit = entry.seen.size > 1 ? receipt.spec.checkpointIntervalMs : receipt.spec.firstProgressMs;
			const expired = this.monotonicNow() - entry.lastProgressAt > limit;
			const observed = this.readFiles(receipt.spec.paths);
			if (this.revision(observed) !== this.revision(entry.latest)) this.capture(id, "source");
			if (expired) return this.fail(id, "No new persisted source revision within the slice progress bound.");
		} catch (error) { return this.fail(id, error instanceof Error ? error.message : String(error)); }
		return undefined;
	}
	private fail(id: string, reason: string): string {
		const { receipt } = this.get(id);
		receipt.state = "blocked";
		receipt.errors.push(reason);
		this.save(receipt);
		return reason;
	}
	private taskSucceeded(result: WorkflowScriptChildResult | undefined): boolean {
		return !!result && typeof result.runId === "string" && !!result.runId.trim() && result.ok === true && !result.error && !result.detached && !result.stopped && !result.interrupted && !result.terminalOutcome && !result.externalAdapter
			&& (!result.results || result.results.every((item) => !item.error && item.exitCode === 0));
	}
	seal(id: string, writer?: WorkflowScriptChildResult): SliceReceipt {
		const entry = this.get(id), receipt = entry.receipt;
		if (receipt.state !== "writing" && receipt.state !== "blocked") throw new Error("Slice has already been sealed.");
		if (receipt.spec.writer) this.tick(id);
		if (receipt.spec.parent) {
			try { this.verifyInputs(receipt.spec.parent.artifacts); } catch (error) { this.fail(id, String(error)); }
		}
		try { this.capture(id, "handoff"); } catch (error) { this.fail(id, String(error)); }
		receipt.writer = writer ? this.resultEvidence(writer) : { producer: "parent", authorization: receipt.spec.parent?.authorization };
		const structured = writer?.structuredOutput;
		if (receipt.spec.writer && (!this.taskSucceeded(writer) || !record(structured) || Object.keys(structured).sort().join(",") !== "status,summary,validation" || structured.status !== "complete" || typeof structured.summary !== "string" || !structured.summary.trim() || !["none", "static"].includes(String(structured.validation)))) this.fail(id, "Writer failed or did not return a valid complete source-only handoff.");
		if (receipt.spec.writer && (entry.seen.size < 2 || receipt.checkpoints[0]?.revision === this.revision(entry.latest))) this.fail(id, "Writer persisted no new deliverable revision.");
		if (entry.latest.some((file) => !file.sha256 || file.bytes === 0)) this.fail(id, "Required deliverable missing or empty.");
		if (receipt.state === "blocked") { this.fixed(id, "terminal.json", receipt); return this.save(receipt); }
		receipt.state = "review-required";
		receipt.revision = this.revision(entry.latest);
		receipt.reviewTask = formatSliceReviewTask({ revision: receipt.revision, deliverable: receipt.spec.deliverable, criteria: receipt.spec.criteria, frozen: entry.latest, writer: receipt.writer, timeoutMs: receipt.spec.reviewer.timeoutMs, brief: receipt.spec.brief });
		return this.save(receipt);
	}
	private resultEvidence(result: WorkflowScriptChildResult): unknown {
		return { key: result.key, runId: result.runId ?? null, reportedOk: result.ok, taskOk: this.taskSucceeded(result), error: result.error ?? null, terminalOutcome: result.terminalOutcome ?? null, structuredOutput: result.structuredOutput ?? null, outputReference: result.outputReference ?? null, artifactPaths: result.artifactPaths, processClosure: "not inferred from task result; inspect native process-terminal evidence" };
	}
	reviewed(id: string, result: WorkflowScriptChildResult | undefined): SliceReceipt {
		const { receipt, latest } = this.get(id);
		if (receipt.state !== "review-required") throw new Error("Slice is not awaiting review.");
		receipt.review = result ? this.resultEvidence(result) : { error: "missing reviewer result" };
		const structured = result?.structuredOutput;
		try {
			const observed = this.readFiles(latest.map((file) => file.snapshot!));
			if (observed.some((file, index) => file.sha256 !== latest[index]?.sha256)) throw new Error("Frozen review revision was modified.");
			if (!this.taskSucceeded(result) || !result?.runId || !record(structured) || Object.keys(structured).sort().join(",") !== "findings,revision,verdict" || structured.verdict !== "approved" || structured.revision !== receipt.revision || typeof structured.findings !== "string") throw new Error("Review missing, failed, malformed, blocked, or revision-mismatched.");
			if (record(receipt.writer) && result.runId === receipt.writer.runId) throw new Error("Reviewer is not independent of writer.");
			receipt.state = "parent-decision";
		} catch (error) { this.fail(id, String(error)); }
		this.fixed(id, "terminal.json", receipt);
		return this.save(receipt);
	}
	accept(id: string, revision: string, reason: string): SliceReceipt {
		const receipt = this.readFixed(id, "terminal.json");
		if (receipt.workflowRunId === this.context.workflowRunId) throw new Error("Parent acceptance requires a separate workflow after examining the review.");
		if (receipt.state !== "parent-decision" || !HASH.test(revision) || receipt.revision !== revision) throw new Error("Slice has no approved exact revision for parent acceptance.");
		const final = receipt.checkpoints.at(-1)?.files;
		if (!final) throw new Error("Missing frozen handoff.");
		const observed = this.readFiles(final.map((file) => file.snapshot!));
		if (observed.some((file, index) => file.sha256 !== final[index]?.sha256)) throw new Error("Frozen review revision changed before acceptance.");
		receipt.acceptance = { workflowRunId: this.context.workflowRunId, revision, reason: text(reason, "acceptance reason") };
		this.fixed(id, "accepted.json", receipt);
		return this.save(receipt);
	}
	abandon(reason: string): string[] {
		const persistenceErrors: string[] = [];
		for (const [id, { receipt }] of this.active) {
			// Sealed/reviewed attempts already have immutable terminal evidence.
			if (fs.existsSync(path.join(this.dir(id), "terminal.json"))) continue;
			// Capture failure (including an exhausted checkpoint budget) must never
			// suppress terminal persistence or erase an earlier progress failure.
			try { this.capture(id, "handoff"); } catch (error) { receipt.errors.push(`Final capture failed: ${String(error)}`); }
			receipt.state = "blocked";
			receipt.errors.push(reason);
			try { this.fixed(id, "terminal.json", receipt); } catch (error) { persistenceErrors.push(`Slice ${id} terminal persistence failed: ${String(error)}`); }
			try { this.save(receipt); } catch (error) { persistenceErrors.push(`Slice ${id} journal persistence failed: ${String(error)}`); }
		}
		return persistenceErrors;
	}
	assertLaunch(key: string): void {
		if (!this.active.size) return;
		for (const { receipt } of this.active.values()) {
			if (receipt.state === "writing" && key === `${receipt.spec.key}.writer`) return;
			if (receipt.state === "review-required" && key === `${receipt.spec.key}.review`) return;
		}
		throw new Error("Slice requires a parent decision; dependent mutation and automatic retries are blocked.");
	}
	/** Self-contained writer assignment built from the validated spec and trusted host cwd. */
	writerTask(id: string): string {
		const { receipt } = this.get(id);
		const spec = receipt.spec;
		if (!spec.writer) throw new Error("Parent-produced slices have no writer assignment.");
		return formatSliceWriterTask({ cwd: this.context.cwd, deliverable: spec.deliverable, paths: spec.paths, inputs: spec.inputs, dependencies: spec.dependencies, criteria: spec.criteria, firstProgressMs: spec.firstProgressMs, checkpointIntervalMs: spec.checkpointIntervalMs, timeoutMs: spec.writer.timeoutMs, toolBudget: spec.writer.toolBudget, successorOf: spec.successorOf, brief: spec.brief });
	}
	key(id: string): string { return this.get(id).receipt.spec.key; }
	policy(key: string): "writer" | "reviewer" | undefined {
		for (const { receipt } of this.active.values()) {
			if (key === `${receipt.spec.key}.writer`) return "writer";
			if (key === `${receipt.spec.key}.review`) return "reviewer";
		}
		return undefined;
	}
	attemptForWriter(key: string): string | undefined {
		for (const [id, { receipt }] of this.active) if (key === `${receipt.spec.key}.writer`) return id;
		return undefined;
	}
}
