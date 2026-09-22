/**
 * Foreground children run as in-process pi sessions. These tests drive
 * `runSync` against the scripted child session factory and check the seams
 * the in-process launch owns: hook config, steering, interrupt, timeout,
 * structured output capture, disposal, and detach.
 */

import { execFileSync } from "node:child_process";
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import type { MockPi } from "../support/helpers.ts";
import { createMockPi, createTempDir, events, makeAgent, makeAgentConfigs, removeTempDir } from "../support/helpers.ts";
import { runSync } from "../../src/runs/foreground/execution.ts";
import { childSessionFactory, createDefaultChildSessionFactory, disposeChildSessions, type ChildSessionFactory, type ChildSessionLaunch, type PiCodingAgentModule } from "../../src/runs/shared/child-session.ts";
import { buildInProcessChildLaunch } from "../../src/runs/shared/child-launch.ts";
import { runChildSession } from "../../src/runs/background/run-child-session.ts";
import { createNestedRoute } from "../../src/runs/shared/nested-events.ts";
import { createStructuredOutputRuntime } from "../../src/runs/shared/structured-output.ts";
import { rewriteSubagentPrompt } from "../../src/runs/shared/subagent-prompt-runtime.ts";
import { SAME_SESSION_ACCOUNT_FALLBACK_NOTICE } from "../../src/runs/shared/model-resolution.ts";
import type { ForegroundChildSessionControls, SingleResult } from "../../src/shared/types.ts";

async function waitFor(read: () => boolean, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!read()) {
		if (Date.now() > deadline) throw new Error("Timed out waiting for test condition.");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

describe("in-process foreground child", () => {
	let tempDir: string;
	let mockPi: MockPi;
	const savedEnv = { ...process.env };

	before(() => {
		mockPi = createMockPi();
		mockPi.install();
	});

	after(() => {
		mockPi.uninstall();
	});

	beforeEach(() => {
		tempDir = createTempDir();
		mockPi.reset();
		process.env.PI_SUBAGENT_CHILD_AGENT = savedEnv.PI_SUBAGENT_CHILD_AGENT ?? "";
		delete process.env.PI_SUBAGENT_CHILD_AGENT;
	});

	after(() => removeTempDir(tempDir));

	it("passes the child hooks a typed config built without the environment", async () => {
		process.env.PI_SUBAGENT_CHILD_AGENT = "leaked-parent-value";
		try {
			mockPi.onCall({ output: "done" });
			const result = await runSync(tempDir, makeAgentConfigs(["echo"]), "echo", "Task", { runId: "hooks-config", index: 3, waitToolEnabled: false });
			assert.equal(result.exitCode, 0);
			const [session] = mockPi.sessions;
			assert.ok(session, "child session was created");
			assert.equal(session.launch.runtime.agent, "echo");
			assert.equal(session.launch.runtime.runId, "hooks-config");
			assert.equal(session.launch.runtime.childIndex, 3);
			assert.equal(session.launch.runtime.fanoutChild, false);
			assert.equal(session.launch.runtime.waitTool.enabled, false);
			assert.equal(session.launch.runtime.steerInbox, undefined, "in-process children have no steer inbox");
			assert.equal(session.launch.runtime.depth, 1);
			assert.equal(session.task?.startsWith("Task: Task"), true);
			assert.equal(session.launch.systemPrompt?.startsWith('<active_agent name="echo"/>'), true);
			assert.deepEqual(session.launch.storage, { kind: "memory" });
		} finally {
			delete process.env.PI_SUBAGENT_CHILD_AGENT;
		}
	});

	it("projects authoritative native-machine Git evidence into the public foreground result", async () => {
		mockPi.onCall({ output: "done" }); const base = childSessionFactory(); const wrapped: ChildSessionFactory = { async create(input) { const child = await base.create(input); Object.defineProperty(child, "machineEvidence", { value: { machineId: "remote-machine", initial: { head: "aaa", dirty: false }, final: { head: "bbb", dirty: true } } }); return child; }, dispose: () => base.dispose() };
		const result = await runSync(tempDir, makeAgentConfigs(["echo"]), "echo", "Task", { runId: "native-git-evidence", waitToolEnabled: false, childSessionFactory: wrapped });
		assert.deepEqual(result.nativeMachine, { provider: "herdr", machineId: "remote-machine", initialGit: { head: "aaa", dirty: false }, finalGit: { head: "bbb", dirty: true } });
	});

	it("adds the fanout hook and nested route only for fanout-authorized children", async () => {
		const route = createNestedRoute("hooks-fanout");
		try {
			mockPi.onCall({ output: "done" });
			const result = await runSync(tempDir, [makeAgent("delegator", { tools: ["read", "subagent"] })], "delegator", "Task", {
				runId: "hooks-fanout",
				nestedRoute: route,
			});
			assert.equal(result.exitCode, 0);
			const [session] = mockPi.sessions;
			assert.equal(session?.launch.runtime.fanoutChild, true);
			assert.deepEqual(session?.launch.runtime.nestedRoute, route);
			assert.deepEqual(session?.launch.runtime.nestedParent, { parentRunId: "hooks-fanout", parentChildIndex: 0, depth: 1, path: [{ runId: "hooks-fanout", stepIndex: 0, agent: "delegator" }] });
			assert.deepEqual(session?.launch.tools, ["read", "subagent"]);
		} finally {
			fs.rmSync(path.dirname(route.eventSink), { recursive: true, force: true });
		}
	});

	it("routes steer and follow-up to the child session", async () => {
		const release = path.join(tempDir, "release");
		mockPi.onCall({ steps: [{ waitForPath: release, jsonl: [{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "steered" }], model: "mock/test-model", stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } }] }] });
		let controls: ForegroundChildSessionControls | undefined;
		const run = runSync(tempDir, makeAgentConfigs(["echo"]), "echo", "Task", {
			runId: "steer-session",
			onChildSession: (next) => { controls = next; },
		});
		await waitFor(() => controls !== undefined);
		await controls!.steer("Focus on tests.");
		await controls!.followUp("Then update docs.");
		fs.writeFileSync(release, "go");
		const result = await run;
		assert.equal(result.exitCode, 0);
		assert.deepEqual(mockPi.sessions[0]?.steers, [
			{ text: "Focus on tests.", mode: "steer" },
			{ text: "Then update docs.", mode: "followUp" },
		]);
	});

	it("does not abort when a steer arrives after the final stop and turn_start is delayed", async () => {
		mockPi.onCall({
			jsonl: [events.assistantMessage("before steer")],
			keepAliveAfterFinalMessageMs: 15_000,
			queuedMessageTurnStartDelayMs: 1400,
			queuedMessageOutput: "after steer",
		});
		let controls: ForegroundChildSessionControls | undefined;
		const run = runSync(tempDir, makeAgentConfigs(["echo"]), "echo", "Task", {
			runId: "queued-steer-after-final",
			onChildSession: (next) => { controls = next; },
		});
		await waitFor(() => controls !== undefined && mockPi.sessions[0]?.scriptedFinalEmitted === true);
		await controls!.steer("Continue after the final stop.");
		const result = await run;
		assert.equal(result.exitCode, 0, result.error);
		assert.equal(result.error, undefined);
		assert.equal(result.finalOutput, "after steer");
		assert.equal(mockPi.sessions[0]?.aborted, false);
		assert.deepEqual(mockPi.sessions[0]?.steers, [{ text: "Continue after the final stop.", mode: "steer" }]);
	});

	for (const type of ["turn_start", "agent_start", "auto_retry_start"]) {
		it(`foreground keeps resumed work alive after ${type}`, async () => {
			mockPi.onCall({
				steps: [
					{ jsonl: [events.assistantMessage("before continuation"), { type }] },
					// Queued steering/follow-up work is allowed to outlive the old final-stop grace.
					{ delay: 1400, jsonl: [events.assistantMessage("after continuation")] },
				],
			});
			const result = await runSync(tempDir, makeAgentConfigs(["echo"]), "echo", "Task", { runId: `resumed-${type}` });
			assert.equal(result.exitCode, 0, result.error);
			assert.equal(result.finalOutput, "after continuation");
			assert.equal(mockPi.sessions[0]?.aborted, false);
		});
	}

	it("aborts the child session on interrupt and disposes it", async () => {
		mockPi.onCall({ hangUntilAbort: true });
		const interrupt = new AbortController();
		const run = runSync(tempDir, makeAgentConfigs(["echo"]), "echo", "Task", { runId: "interrupt-session", interruptSignal: interrupt.signal });
		await waitFor(() => mockPi.sessions.length === 1);
		await waitFor(() => mockPi.sessions[0]?.task !== undefined);
		interrupt.abort();
		const result = await run;
		assert.equal(result.interrupted, true);
		assert.equal(result.exitCode, 0);
		assert.equal(mockPi.sessions[0]?.aborted, true);
		assert.equal(mockPi.sessions[0]?.disposed, true);
	});

	it("aborts the child session on timeout and disposes it", async () => {
		mockPi.onCall({ hangUntilAbort: true });
		const result = await runSync(tempDir, makeAgentConfigs(["echo"]), "echo", "Task", { runId: "timeout-session", timeoutMs: 60 });
		assert.equal(result.timedOut, true);
		assert.equal(result.exitCode, 1);
		assert.match(result.error ?? "", /timed out after 60ms/);
		assert.equal(mockPi.sessions[0]?.aborted, true);
		assert.equal(mockPi.sessions[0]?.disposed, true);
	});

	it("disposes the child session after a normal completion", async () => {
		mockPi.onCall({ output: "finished" });
		const result = await runSync(tempDir, makeAgentConfigs(["echo"]), "echo", "Task", { runId: "dispose-session" });
		assert.equal(result.exitCode, 0);
		assert.equal(result.finalOutput, "finished");
		assert.equal(mockPi.sessions[0]?.settled, true);
		assert.equal(mockPi.sessions[0]?.disposed, true);
	});

	it("skips an unregistered configured primary without inventing a model attempt", async () => {
		mockPi.onCall({ output: "registered fallback completed" });
		const result = await runSync(tempDir, [makeAgent("worker", {
			model: "openai/placeholder",
			fallbackModels: ["missing/also", "devin/swe-2:high", "devin/swe-2:low"],
		})], "worker", "Perform once", {
			runId: "unregistered-primary-fallback",
			sessionFile: path.join(tempDir, "new-child.jsonl"),
			forkSanitized: true,
			availableModels: [{ provider: "devin", id: "devin/swe-2", fullId: "devin/devin/swe-2", api: "openai-completions" }],
		});
		assert.equal(result.exitCode, 0, result.error);
		assert.equal(result.requestedModel, "openai/placeholder");
		assert.equal(mockPi.sessions.length, 1);
		assert.equal(mockPi.sessions[0]?.launch.model, "devin/devin/swe-2:high");
		assert.equal(mockPi.sessions[0]?.task, "Task: Perform once");
		assert.ok(!result.attemptedModels?.includes("openai/placeholder"));
	});

	it("does not replace an unregistered model for an existing child session", async () => {
		const sessionFile = path.join(tempDir, "retained-session.jsonl");
		fs.writeFileSync(sessionFile, "");
		await assert.rejects(runSync(tempDir, [makeAgent("worker", {
			model: "openai/placeholder", fallbackModels: ["devin/swe-2"],
		})], "worker", "Continue", {
			runId: "retained-unregistered-primary", sessionFile,
			availableModels: [{ provider: "devin", id: "swe-2", fullId: "devin/swe-2" }],
		}), /Unknown subagent model/);
		assert.equal(mockPi.sessions.length, 0);
	});

	it("falls back to a different model after a zero-progress HTTP 401", async () => {
		const primary = "openai/placeholder";
		const fallback = "devin/swe-2";
		const finalFallback = "anthropic/claude-sonnet-4";
		const error = "OpenAI API error (401): invalid_api_key";
		const fallbackError = "Provider error (503): temporarily unavailable";
		mockPi.onCall({ jsonl: [{
			type: "message_end",
			message: {
				role: "assistant",
				content: [],
				model: "placeholder",
				stopReason: "error",
				errorMessage: error,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
			},
		}] });
		mockPi.onCall({ jsonl: [{
			type: "message_end",
			message: {
				role: "assistant",
				content: [],
				model: "swe-2",
				stopReason: "error",
				errorMessage: fallbackError,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
			},
		}] });
		mockPi.onCall({ output: "fallback completed" });
		const result = await runSync(tempDir, [makeAgent("worker", {
			model: primary,
			fallbackModels: [fallback, finalFallback],
		})], "worker", "Perform once", {
			runId: "zero-progress-401-fallback",
			availableModels: [
				{ provider: "openai", id: "placeholder", fullId: primary },
				{ provider: "devin", id: "swe-2", fullId: fallback },
				{ provider: "anthropic", id: "claude-sonnet-4", fullId: finalFallback },
			],
		});
		assert.equal(result.exitCode, 0, result.error);
		assert.equal(result.finalOutput, "fallback completed");
		assert.equal(mockPi.sessions.length, 3);
		assert.deepEqual(mockPi.sessions.map((session) => session.launch.model), [primary, fallback, finalFallback]);
		assert.deepEqual(mockPi.sessions.map((session) => session.task), ["Task: Perform once", "Task: Perform once", "Task: Perform once"]);
		assert.deepEqual(result.attemptedModels, [primary, fallback, finalFallback]);
		assert.deepEqual(result.modelAttempts?.map(({ model, success, error: attemptError }) => ({ model, success, error: attemptError })), [
			{ model: primary, success: false, error },
			{ model: fallback, success: false, error: fallbackError },
			{ model: finalFallback, success: true, error: undefined },
		]);
	});

	it("does not replay a different model after any useful assistant output", async () => {
		const error = "OpenAI API error (401): invalid_api_key";
		mockPi.onCall({ jsonl: [{
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "partial output" }],
				model: "gpt-5-mini",
				stopReason: "error",
				errorMessage: error,
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
			},
		}] });
		const result = await runSync(tempDir, [makeAgent("worker", {
			model: "openai/gpt-5-mini",
			fallbackModels: ["anthropic/claude-sonnet-4"],
		})], "worker", "Do not replay", {
			runId: "useful-output-no-fallback",
			availableModels: [
				{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
				{ provider: "anthropic", id: "claude-sonnet-4", fullId: "anthropic/claude-sonnet-4" },
			],
		});
		assert.equal(result.exitCode, 1);
		assert.equal(result.error, error);
		assert.equal(mockPi.sessions.length, 1);
		assert.deepEqual(result.attemptedModels, ["openai/gpt-5-mini"]);
	});

	it("does not retry after the first zero-progress attempt exhausts the usage budget", async () => {
		const error = "OpenAI API error (401): invalid_api_key";
		mockPi.onCall({ jsonl: [{ type: "message_end", message: {
			role: "assistant",
			content: [],
			model: "openai/gpt-5-mini",
			stopReason: "error",
			errorMessage: error,
			usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
		} }] });
		const result = await runSync(tempDir, [makeAgent("worker", {
			model: "openai/gpt-5-mini",
			fallbackModels: ["anthropic/claude-sonnet-4"],
		})], "worker", "Respect budget", {
			runId: "usage-budget-no-fallback",
			usageBudget: { tokens: { hard: 5 } },
			availableModels: [
				{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
				{ provider: "anthropic", id: "claude-sonnet-4", fullId: "anthropic/claude-sonnet-4" },
			],
		});
		assert.equal(result.exitCode, 1);
		assert.equal(mockPi.sessions.length, 1);
	});

	it("does not retry a zero-output failure when mutation evidence changed", async () => {
		execFileSync("git", ["init", "-q", tempDir]);
		const changed = path.join(tempDir, "provider-side-effect.txt");
		fs.writeFileSync(changed, "before");
		execFileSync("git", ["-C", tempDir, "add", "provider-side-effect.txt"]);
		execFileSync("git", ["-C", tempDir, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"]);
		const error = "Provider error (503): temporarily unavailable";
		mockPi.onCall({
			writeFiles: [{ path: changed, content: "changed" }],
			jsonl: [{ type: "message_end", message: {
				role: "assistant",
				content: [],
				model: "openai/gpt-5-mini",
				stopReason: "error",
				errorMessage: error,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
			} }],
		});
		const result = await runSync(tempDir, [makeAgent("worker", {
			model: "openai/gpt-5-mini",
			fallbackModels: ["anthropic/claude-sonnet-4"],
		})], "worker", "Do not replay mutations", {
			runId: "mutation-evidence-no-fallback",
			availableModels: [
				{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
				{ provider: "anthropic", id: "claude-sonnet-4", fullId: "anthropic/claude-sonnet-4" },
			],
		});
		assert.equal(result.exitCode, 1);
		assert.equal(mockPi.sessions.length, 1);
		assert.equal(fs.readFileSync(changed, "utf8"), "changed");
	});

	it("does not start a different-model fallback after a completed tool", async () => {
		const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } };
		mockPi.onCall({ jsonl: [
			{ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", id: "read-before-limit", name: "read", arguments: { path: "state.txt" } }], model: "anthropic/claude-sonnet-4", stopReason: "toolUse", usage } },
			{ type: "tool_execution_start", toolCallId: "read-before-limit", toolName: "read", args: { path: "state.txt" } },
			{ type: "tool_result_end", message: { role: "toolResult", toolCallId: "read-before-limit", toolName: "read", isError: false, content: [{ type: "text", text: "state" }] } },
			{ type: "tool_execution_end", toolCallId: "read-before-limit", toolName: "read" },
			{ type: "message_end", message: { role: "assistant", content: [], model: "anthropic/claude-sonnet-4", stopReason: "error", errorMessage: "429 rate limit", usage } },
		] });
		const result = await runSync(tempDir, [makeAgent("worker", {
			model: "anthropic/claude-sonnet-4",
			fallbackModels: ["openai/gpt-5-mini"],
		})], "worker", "Read once", {
			runId: "post-tool-no-cross-model-replay",
			availableModels: [
				{ provider: "anthropic", id: "claude-sonnet-4", fullId: "anthropic/claude-sonnet-4" },
				{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
			],
		});
		assert.equal(result.exitCode, 1);
		assert.equal(mockPi.sessions.length, 1);
		assert.deepEqual(result.attemptedModels, ["anthropic/claude-sonnet-4"]);
		assert.deepEqual(mockPi.sessions[0]?.switchedModels, []);
	});

	it("continues a live session across an exact-model account limit without replaying a completed mutation", async () => {
		const target = path.join(tempDir, "mutated-once.txt");
		const usage = { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } };
		mockPi.onCall({
			writeFiles: [{ path: target, content: "once" }],
			jsonl: [
				{ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", id: "write-1", name: "write", arguments: { path: target, content: "once" } }], model: "anthropic/claude-sonnet-4", stopReason: "toolUse", usage } },
				{ type: "tool_execution_start", toolCallId: "write-1", toolName: "write", args: { path: target, content: "once" } },
				{ type: "tool_result_end", message: { role: "toolResult", toolCallId: "write-1", toolName: "write", isError: false, content: [{ type: "text", text: "wrote once" }] } },
				{ type: "tool_execution_end", toolCallId: "write-1", toolName: "write" },
				{ type: "message_end", message: { role: "assistant", content: [], model: "anthropic/claude-sonnet-4", stopReason: "error", errorMessage: "429 rate limit", usage } },
			],
		});
		mockPi.onCall({ output: "continued from the prior tool result" });
		const result = await runSync(tempDir, [makeAgent("worker", {
			model: "anthropic/claude-sonnet-4",
			fallbackModels: ["anthropic-2/claude-sonnet-4", "openai/gpt-5-mini"],
		})], "worker", "Write exactly once", {
			runId: "same-session-account-continuation",
			availableModels: [
				{ provider: "anthropic", id: "claude-sonnet-4", fullId: "anthropic/claude-sonnet-4" },
				{ provider: "anthropic-2", id: "claude-sonnet-4", fullId: "anthropic-2/claude-sonnet-4" },
				{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
			],
		});
		assert.equal(result.exitCode, 0, result.error);
		assert.equal(fs.readFileSync(target, "utf8"), "once");
		assert.equal(mockPi.sessions.length, 1);
		assert.deepEqual(mockPi.sessions[0]?.switchedModels, ["anthropic-2/claude-sonnet-4"]);
		assert.deepEqual(mockPi.sessions[0]?.tasks.slice(1), [SAME_SESSION_ACCOUNT_FALLBACK_NOTICE]);
		assert.equal(result.progressSummary?.toolCount, 1);
		assert.deepEqual(result.attemptedModels, ["anthropic/claude-sonnet-4", "anthropic-2/claude-sonnet-4"]);
		assert.deepEqual(result.modelAttempts?.map(({ model, success }) => ({ model, success })), [
			{ model: "anthropic/claude-sonnet-4", success: false },
			{ model: "anthropic-2/claude-sonnet-4", success: true },
		]);
	});

	it("uses the same no-replay continuation seam in the detached child driver", async () => {
		const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } };
		mockPi.onCall({ jsonl: [
			{ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "state.txt" } }], model: "openai-codex/gpt-5.4", stopReason: "toolUse", usage } },
			{ type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: { path: "state.txt" } },
			{ type: "tool_result_end", message: { role: "toolResult", toolCallId: "read-1", toolName: "read", isError: false, content: [{ type: "text", text: "prior result" }] } },
			{ type: "tool_execution_end", toolCallId: "read-1", toolName: "read" },
			{ type: "message_end", message: { role: "assistant", content: [], model: "openai-codex/gpt-5.4", stopReason: "error", errorMessage: "quota exhausted", usage } },
		] });
		mockPi.onCall({ output: "continued asynchronously" });
		const launch = buildInProcessChildLaunch({
			sessionEnabled: false,
			model: "openai-codex/gpt-5.4",
			inheritProjectContext: false,
			inheritGlobalContext: false,
			inheritSkills: false,
			cwd: tempDir,
			childAgentName: "worker",
			childIndex: 0,
			host: "runner",
		});
		const result = await runChildSession({
			factory: childSessionFactory(),
			launch,
			prompt: "Task: inspect state once",
			appendChildEvent: () => {},
			writeOutputLine: () => {},
			expectedModelForVerification: "openai-codex/gpt-5.4",
			accountFallbackCandidates: ["openai-codex-2/gpt-5.4"],
			modelVerificationRegistry: [
				{ provider: "openai-codex", id: "gpt-5.4", fullId: "openai-codex/gpt-5.4" },
				{ provider: "openai-codex-2", id: "gpt-5.4", fullId: "openai-codex-2/gpt-5.4" },
			],
		});
		assert.equal(result.exitCode, 0, result.error);
		assert.equal(result.toolCount, 1);
		assert.deepEqual(result.sameSessionAccountFallback?.attemptedCandidates, ["openai-codex/gpt-5.4", "openai-codex-2/gpt-5.4"]);
		assert.equal(mockPi.sessions.length, 1);
		assert.deepEqual(mockPi.sessions[0]?.tasks.slice(1), [SAME_SESSION_ACCOUNT_FALLBACK_NOTICE]);
		assert.equal(result.messages.some((message) => message.role === "toolResult" && (message as { toolCallId?: string }).toolCallId === "read-1"), true);
	});

	it("reports the run only after the child session's shutdown work finished", async () => {
		mockPi.onCall({ output: "done" });
		let shutdownDone = false;
		const inner = childSessionFactory();
		const wrapped: ChildSessionFactory = {
			...inner,
			create: async (launch) => {
				const session = await inner.create(launch);
				const dispose = session.dispose.bind(session);
				session.dispose = () => dispose().then(() => new Promise<void>((resolve) => setTimeout(() => { shutdownDone = true; resolve(); }, 30)));
				return session;
			},
		};
		const result = await runSync(tempDir, makeAgentConfigs(["echo"]), "echo", "Task", { runId: "dispose-order", childSessionFactory: wrapped });
		assert.equal(result.exitCode, 0);
		assert.equal(shutdownDone, true);
	});

	it("captures structured output in memory", async () => {
		const structured = createStructuredOutputRuntime({ type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } }, tempDir);
		mockPi.onCall({ structuredOutput: { ok: true } });
		const result = await runSync(tempDir, makeAgentConfigs(["echo"]), "echo", "Task", { runId: "structured-memory", structuredOutput: structured });
		assert.equal(result.exitCode, 0, result.error);
		assert.deepEqual(result.structuredOutput, { ok: true });
		assert.equal(mockPi.sessions[0]?.launch.runtime.structuredOutput?.schema.type, "object");
		assert.deepEqual(JSON.parse(fs.readFileSync(structured.outputPath, "utf-8")), { ok: true });
	});

	it("fails when the child never calls structured_output", async () => {
		const structured = createStructuredOutputRuntime({ type: "object" }, tempDir);
		mockPi.onCall({ output: "prose only" });
		const result = await runSync(tempDir, makeAgentConfigs(["echo"]), "echo", "Task", { runId: "structured-missing", structuredOutput: structured });
		assert.equal(result.exitCode, 1);
		assert.match(result.error ?? "", /Missing structured_output call/);
		assert.equal(result.structuredOutputFailed, true);
	});

	it("keeps a detached child running in-process and delivers its terminal result", async () => {
		const release = path.join(tempDir, "release-detach");
		mockPi.onCall({ steps: [{ waitForPath: release, jsonl: [{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "after detach" }], model: "mock/test-model", stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } }] }] });
		let detach: ((reason?: string) => boolean) | undefined;
		let terminal: SingleResult | undefined;
		const receipt = await new Promise<SingleResult>((resolve, reject) => {
			runSync(tempDir, makeAgentConfigs(["echo"]), "echo", "Task", {
				runId: "detach-session",
				onDetachReady: (next) => { detach = next; },
				onDetachReceipt: () => true,
				onDetachedExit: (result) => { terminal = result; },
			}).then(resolve, reject);
			void waitFor(() => detach !== undefined && mockPi.sessions[0]?.task !== undefined).then(() => {
				assert.equal(detach!("user request"), true);
			}, reject);
		});
		assert.equal(receipt.detached, true);
		assert.equal(receipt.detachedReason, "user request");
		assert.equal(mockPi.sessions[0]?.aborted, false, "detach must not abort the session");
		await disposeChildSessions();
		assert.equal(mockPi.sessions[0]?.aborted, false, "parent session shutdown must not abort a detached child");
		fs.writeFileSync(release, "go");
		await waitFor(() => terminal !== undefined);
		assert.equal(terminal?.exitCode, 0);
		assert.equal(terminal?.finalOutput, "after detach");
		assert.equal(terminal?.detachedReason, "user request");
		assert.equal(mockPi.sessions[0]?.disposed, true);
	});

	it("reports a parent session shutdown as the reason an attached child stopped", async () => {
		mockPi.onCall({ hangUntilAbort: true });
		const run = runSync(tempDir, makeAgentConfigs(["echo"]), "echo", "Task", { runId: "shutdown-attached" });
		await waitFor(() => mockPi.sessions[0]?.task !== undefined);
		await disposeChildSessions();
		const result = await run;
		assert.equal(result.exitCode, 1);
		assert.equal(result.error, "Subagent stopped because the parent session shut down.");
	});
});

/** A pi module stub whose loader reads `process.env` after an await, the way a real extension load does. */
function stubPi(session: Record<string, unknown> = {}, onReload?: () => void): PiCodingAgentModule {
	return {
		ModelRuntime: { create: async () => ({}) },
		SettingsManager: { create: () => ({}) },
		DefaultResourceLoader: class { async reload() { await new Promise((resolve) => setTimeout(resolve, 10)); onReload?.(); } },
		SessionManager: { inMemory: () => ({}) },
		resolveCliModel: () => ({}),
		createAgentSession: async () => ({ session: { bindExtensions: async () => {}, dispose() {}, extensionRunner: { hasHandlers: () => false }, subscribe: () => () => {}, prompt: async () => {}, abort: async () => {}, steer: async () => {}, followUp: async () => {}, messages: [], sessionId: "s", ...session } }),
	} as unknown as PiCodingAgentModule;
}
const stubLaunch: ChildSessionLaunch = { cwd: process.cwd(), storage: { kind: "memory" }, extensionPaths: [], ambientExtensions: false, hooks: [], noSkills: true, noContextFiles: true, runtime: { fanoutChild: false, depth: 1, waitTool: { enabled: false }, fast: false } as ChildSessionLaunch["runtime"] };

describe("default child session factory", () => {
	it("serializes process env through extension loading and session start across concurrent launches", async () => {
		const seen: string[] = [];
		const bound: string[] = [];
		const bindExtensions = async () => { await new Promise((resolve) => setTimeout(resolve, 10)); bound.push(process.env.PI_SUBAGENT_TEST_ENV ?? ""); };
		const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => stubPi({ bindExtensions }, () => { seen.push(process.env.PI_SUBAGENT_TEST_ENV ?? ""); }) });
		await Promise.all([
			factory.create({ ...stubLaunch, processEnv: { PI_SUBAGENT_TEST_ENV: "a" } }),
			factory.create({ ...stubLaunch, processEnv: { PI_SUBAGENT_TEST_ENV: "b" } }),
		]);
		delete process.env.PI_SUBAGENT_TEST_ENV;
		assert.deepEqual(seen, ["a", "b"]);
		assert.deepEqual(bound, ["a", "b"]);
	});

	it("marks each child's loader as reloaded so pi resets its extension cache", async () => {
		const flags: boolean[] = [];
		const pi = stubPi();
		pi.DefaultResourceLoader = class { loaded = false; async reload() { flags.push(this.loaded); } } as unknown as PiCodingAgentModule["DefaultResourceLoader"];
		const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => pi });
		await factory.create(stubLaunch);
		await factory.create(stubLaunch);
		assert.deepEqual(flags, [true, true]);
	});

	it("runs the child prompt rewrite before ambient prompt capture without reordering ambient extensions", async () => {
		const agentPrompt = '<active_agent name="remotion-editor"/>\n\neditor instructions';
		const globalPath = path.join(process.env.HOME ?? process.env.USERPROFILE ?? process.cwd(), ".pi", "agent", "AGENTS.md");
		const projectPath = path.join(process.cwd(), "AGENTS.md");
		const orchestrationSkill = '<skill><name>pi-subagents</name><location>/skills/pi-subagents/SKILL.md</location></skill>';
		const assemble = (extra: string) => `${agentPrompt}${extra}`;
		const destructivePrompt = assemble([
			"", "<project_context>",
			`<project_instructions path="${globalPath}">global parent-only instructions</project_instructions>`,
			`<project_instructions path="${projectPath}">project instructions</project_instructions>`,
			"</project_context>", orchestrationSkill,
		].join("\n\n"));
		const boundaryOnlyPrompt = assemble("");
		const orderedPaths: string[][] = [];
		const captureResults: boolean[] = [];
		const forwardedPrompts: string[] = [];
		const pi = stubPi();
		pi.DefaultResourceLoader = class {
			loaded = false;
			private readonly options: { extensionsOverride?: (base: { extensions: Array<{ path: string }>; errors: unknown[]; runtime: object }) => { extensions: Array<{ path: string }>; errors: unknown[]; runtime: object } };
			private result = { extensions: [] as Array<{ path: string }>, errors: [] as unknown[], runtime: {} };
			constructor(options: typeof this.options) { this.options = options; }
			async reload() {
				const base = {
					extensions: [
						{ path: "/ambient/first.ts" },
						{ path: "/ambient/claude-bridge.ts" },
						{ path: "/ambient/last.ts" },
						{ path: "<inline:pi-subagents:prompt-runtime>" },
						{ path: "<inline:pi-subagents:completion-intent>" },
					],
					errors: [] as unknown[],
					runtime: {},
				};
				this.result = this.options.extensionsOverride?.(base) ?? base;
				orderedPaths.push(this.result.extensions.map(({ path: extensionPath }) => extensionPath));
				for (const original of [boundaryOnlyPrompt, destructivePrompt]) {
					let prompt = original;
					let captured: string | undefined;
					for (const { path: extensionPath } of this.result.extensions) {
						if (extensionPath === "<inline:pi-subagents:prompt-runtime>") {
							prompt = rewriteSubagentPrompt(prompt, { inheritProjectContext: true, inheritGlobalContext: false, inheritSkills: true });
						}
						if (extensionPath === "/ambient/claude-bridge.ts") captured = prompt;
					}
					captureResults.push(captured === prompt || (captured !== undefined && prompt.includes(captured)));
					forwardedPrompts.push(prompt);
				}
			}
			getExtensions() { return this.result; }
		} as unknown as PiCodingAgentModule["DefaultResourceLoader"];

		const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => pi });
		await factory.create({
			...stubLaunch,
			ambientExtensions: true,
			hooks: [
				{ name: "pi-subagents:prompt-runtime", factory() {} },
				{ name: "pi-subagents:completion-intent", factory() {} },
			],
		});

		assert.deepEqual(orderedPaths[0], [
			"<inline:pi-subagents:prompt-runtime>",
			"/ambient/first.ts",
			"/ambient/claude-bridge.ts",
			"/ambient/last.ts",
			"<inline:pi-subagents:completion-intent>",
		]);
		assert.deepEqual(captureResults, [true, true], "bridge-style capture must resolve both wrapping and destructive filtering");
		assert.match(forwardedPrompts[1]!, /editor instructions/);
		assert.match(forwardedPrompts[1]!, /project instructions/);
		assert.doesNotMatch(forwardedPrompts[1]!, /global parent-only instructions/);
		assert.doesNotMatch(forwardedPrompts[1]!, /<name>pi-subagents<\/name>/);
	});

	it("resolves models from providers queued during child extension loading", async () => {
		const registeredProviders: string[] = [];
		const registeredNativeProviders: string[] = [];
		let refreshed = false;
		let pendingRuntime: { pendingProviderRegistrations: unknown[]; pendingNativeProviderRegistrations: unknown[] } | undefined;
		const pi = stubPi();
		pi.ModelRuntime = { create: async () => ({ registerProvider: (name: string) => { registeredProviders.push(name); }, registerNativeProvider: (provider: { id: string }) => { registeredNativeProviders.push(provider.id); }, refresh: async () => { refreshed = true; } }) } as unknown as PiCodingAgentModule["ModelRuntime"];
		pi.DefaultResourceLoader = class {
			runtime = {
				pendingProviderRegistrations: [{ name: "router", config: { models: [{ id: "mimo-v2.5" }] }, extensionPath: "/extensions/router.ts" }],
				pendingNativeProviderRegistrations: [{ provider: { id: "native-router", models: [{ id: "native-model" }] }, extensionPath: "/extensions/native-router.ts" }],
			};
			async reload() { pendingRuntime = this.runtime; }
			getExtensions() { return { extensions: [], errors: [], runtime: this.runtime }; }
		} as unknown as PiCodingAgentModule["DefaultResourceLoader"];
		pi.resolveCliModel = (({ cliModel }) => {
			assert.equal(cliModel, "router/mimo-v2.5");
			assert.deepEqual(registeredProviders, ["router"]);
			assert.deepEqual(registeredNativeProviders, ["native-router"]);
			assert.equal(refreshed, true);
			return { model: { provider: "router", id: "mimo-v2.5" } };
		}) as unknown as PiCodingAgentModule["resolveCliModel"];
		pi.createAgentSession = (async ({ model }) => ({ session: { bindExtensions: async () => {}, dispose() {}, extensionRunner: { hasHandlers: () => false }, subscribe: () => () => {}, prompt: async () => {}, abort: async () => {}, steer: async () => {}, followUp: async () => {}, messages: [], sessionId: "s", model } })) as unknown as PiCodingAgentModule["createAgentSession"];

		const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => pi });
		const child = await factory.create({ ...stubLaunch, model: "router/mimo-v2.5" });

		assert.equal(child.modelId, "router/mimo-v2.5");
		assert.deepEqual(pendingRuntime?.pendingProviderRegistrations, []);
		assert.deepEqual(pendingRuntime?.pendingNativeProviderRegistrations, []);
	});

	it("resolves queued providers when the loader has no native provider queue", async () => {
		const registeredProviders: string[] = [];
		let refreshed = false;
		let pendingRuntime: { pendingProviderRegistrations?: unknown[] } | undefined;
		const pi = stubPi();
		pi.ModelRuntime = { create: async () => ({ registerProvider: (name: string) => { registeredProviders.push(name); }, registerNativeProvider: () => {}, refresh: async () => { refreshed = true; } }) } as unknown as PiCodingAgentModule["ModelRuntime"];
		pi.DefaultResourceLoader = class {
			runtime = {
				pendingProviderRegistrations: [{ name: "router", config: { models: [{ id: "mimo-v2.5" }] }, extensionPath: "/extensions/router.ts" }],
			};
			async reload() { pendingRuntime = this.runtime; }
			getExtensions() { return { extensions: [], errors: [], runtime: this.runtime }; }
		} as unknown as PiCodingAgentModule["DefaultResourceLoader"];
		pi.resolveCliModel = (({ cliModel }) => {
			assert.equal(cliModel, "router/mimo-v2.5");
			assert.deepEqual(registeredProviders, ["router"]);
			assert.equal(refreshed, true);
			return { model: { provider: "router", id: "mimo-v2.5" } };
		}) as unknown as PiCodingAgentModule["resolveCliModel"];
		pi.createAgentSession = (async ({ model }) => ({ session: { bindExtensions: async () => {}, dispose() {}, extensionRunner: { hasHandlers: () => false }, subscribe: () => () => {}, prompt: async () => {}, abort: async () => {}, steer: async () => {}, followUp: async () => {}, messages: [], sessionId: "s", model } })) as unknown as PiCodingAgentModule["createAgentSession"];

		const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => pi });
		const child = await factory.create({ ...stubLaunch, model: "router/mimo-v2.5" });

		assert.equal(child.modelId, "router/mimo-v2.5");
		assert.deepEqual(pendingRuntime?.pendingProviderRegistrations, []);
	});

	it("reports a missing extension cache reset when the child loads extension files", async () => {
		const errors: string[] = [];
		const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => stubPi() });
		await factory.create({ ...stubLaunch, onExtensionError: (error) => errors.push(error.extensionPath) });
		await factory.create({ ...stubLaunch, extensionPaths: ["/tmp/ext.ts"], onExtensionError: (error) => errors.push(error.extensionPath) });
		assert.deepEqual(errors, ["<loader>"]);
	});

	it("preserves an initialized parent theme when creating a child session", async () => {
		const themeKey = Symbol.for("@earendil-works/pi-coding-agent:theme");
		const globals = globalThis as Record<symbol, unknown>;
		const previousTheme = globals[themeKey];
		const initialized: Array<string | undefined> = [];
		const pi = stubPi();
		pi.initTheme = ((themeName?: string) => { initialized.push(themeName); }) as PiCodingAgentModule["initTheme"];
		pi.SettingsManager = { create: () => ({ getTheme: () => "vesper-light/vesper-dark" }) } as unknown as PiCodingAgentModule["SettingsManager"];
		const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => pi });
		globals[themeKey] = { name: "vesper-light" };
		try {
			await factory.create(stubLaunch);
			assert.deepEqual(initialized, []);
		} finally {
			if (previousTheme === undefined) delete globals[themeKey];
			else globals[themeKey] = previousTheme;
		}
	});

	it("initializes the theme in a headless runner process", async () => {
		const themeKey = Symbol.for("@earendil-works/pi-coding-agent:theme");
		const globals = globalThis as Record<symbol, unknown>;
		const previousTheme = globals[themeKey];
		const initialized: Array<string | undefined> = [];
		const pi = stubPi();
		pi.initTheme = ((themeName?: string) => { initialized.push(themeName); }) as PiCodingAgentModule["initTheme"];
		pi.SettingsManager = { create: () => ({ getTheme: () => "vesper-light/vesper-dark" }) } as unknown as PiCodingAgentModule["SettingsManager"];
		const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => pi });
		delete globals[themeKey];
		try {
			await factory.create(stubLaunch);
			assert.deepEqual(initialized, ["vesper-light/vesper-dark"]);
		} finally {
			if (previousTheme !== undefined) globals[themeKey] = previousTheme;
		}
	});

	it("disposes the session when bindExtensions rejects", async () => {
		let disposed = 0;
		const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => stubPi({ bindExtensions: async () => { throw new Error("bind failed"); }, dispose: () => { disposed += 1; } }) });
		await assert.rejects(factory.create(stubLaunch), /bind failed/);
		assert.equal(disposed, 1);
	});

	it("leaves detached children running on dispose and keeps the shared runtime", async () => {
		let aborted = 0;
		let runtimes = 0;
		const pi = stubPi({ abort: async () => { aborted += 1; } });
		pi.ModelRuntime = { create: async () => { runtimes += 1; return {}; } } as unknown as PiCodingAgentModule["ModelRuntime"];
		const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => pi });
		const child = await factory.create(stubLaunch);
		child.detached = true;
		await factory.dispose();
		assert.equal(aborted, 0);
		assert.equal(child.shutDown, undefined);
		await factory.create(stubLaunch);
		assert.equal(runtimes, 1, "runtime is kept while a detached child runs");
	});

	it("bounds the wait for a stuck session_shutdown handler", { timeout: 2_000 }, async () => {
		const factory = createDefaultChildSessionFactory({ shutdownTimeoutMs: 50, loadPiCodingAgent: async () => stubPi({ extensionRunner: { hasHandlers: () => true, emit: () => new Promise(() => {}) } }) });
		(await factory.create(stubLaunch)).dispose();
		await factory.dispose();
	});
});
