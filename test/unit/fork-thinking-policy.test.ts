import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { createForkContextResolver, forkedChildRequiresThinkingOff } from "../../src/shared/fork-context.ts";
import { applyForkThinkingToCandidates, applyForkThinkingToModel } from "../../src/runs/shared/model-fallback.ts";

const availableModels = [
	{ provider: "vllm", id: "cyankiwi-model", fullId: "vllm/cyankiwi-model", api: "openai-completions" },
	{ provider: "openai-codex", id: "worker-model", fullId: "openai-codex/worker-model", api: "openai-responses" },
	{ provider: "anthropic", id: "opus", fullId: "anthropic/opus", api: "anthropic-messages" },
	{ provider: "anthropic-2", id: "opus", fullId: "anthropic-2/opus", api: "anthropic-messages" },
];

function writeMinimalSessionFile(filePath: string, id = "session"): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, `{"type":"session","version":1,"id":"${id}","timestamp":"2026-04-16T00:00:00.000Z","cwd":"/tmp"}\n`, "utf-8");
}

function writeSessionJsonl(filePath: string, entries: unknown[]): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf-8");
}

function signedForkEntries(parentSessionFile: string): unknown[] {
	return [
		{ type: "session", version: 1, id: "child", timestamp: "2026-04-16T00:00:00.000Z", cwd: "/tmp", parentSession: parentSessionFile },
		{ type: "message", id: "user-1", parentId: null, timestamp: "2026-04-16T00:00:01.000Z", message: { role: "user", content: "prompt" } },
		{
			type: "message",
			id: "assistant-1",
			parentId: "user-1",
			timestamp: "2026-04-16T00:00:02.000Z",
			message: {
				role: "assistant",
				provider: "anthropic",
				api: "anthropic-messages",
				model: "anthropic/opus",
				content: [{ type: "thinking", thinking: "private chain", thinkingSignature: "signed" }, { type: "text", text: "answer" }],
			},
		},
	];
}

describe("applyForkThinkingToCandidates", () => {
	it("leaves every candidate untouched when the fork was not sanitized", () => {
		const candidates = ["vllm/cyankiwi-model", "anthropic/opus"];
		assert.deepEqual(
			applyForkThinkingToCandidates(candidates, { sanitized: false, availableModels }),
			candidates,
		);
	});

	it("pins off only the candidates that cannot replay a sanitized fork", () => {
		// The worker chain that regressed: a self-hosted primary with Anthropic
		// fallbacks must keep reasoning on the providers that can reason.
		assert.deepEqual(
			applyForkThinkingToCandidates(
				["vllm/cyankiwi-model", "openai-codex/worker-model", "anthropic/opus", "anthropic-2/opus"],
				{ sanitized: true, availableModels },
			),
			["vllm/cyankiwi-model", "openai-codex/worker-model", "anthropic/opus:off", "anthropic-2/opus:off"],
		);
	});

	it("replaces an existing thinking suffix only on Anthropic candidates", () => {
		assert.deepEqual(
			applyForkThinkingToCandidates(["vllm/cyankiwi-model:high", "anthropic/opus:high"], { sanitized: true, availableModels }),
			["vllm/cyankiwi-model:high", "anthropic/opus:off"],
		);
	});

	it("stays conservative for models it cannot resolve", () => {
		assert.deepEqual(
			applyForkThinkingToCandidates(["mystery/model"], { sanitized: true, availableModels }),
			["mystery/model:off"],
		);
		assert.equal(forkedChildRequiresThinkingOff("mystery/model", availableModels), true);
	});

	it("applies the same policy to a single primary model", () => {
		assert.equal(applyForkThinkingToModel("vllm/cyankiwi-model", { sanitized: true, availableModels }), "vllm/cyankiwi-model");
		assert.equal(applyForkThinkingToModel("anthropic/opus", { sanitized: true, availableModels }), "anthropic/opus:off");
		assert.equal(applyForkThinkingToModel(undefined, { sanitized: true, availableModels }), undefined);
	});
});

describe("fork resolver sanitized reporting", () => {
	it("reports sanitization even when no chain-wide thinking override is applied", () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-fork-sanitized-"));
		try {
			const parentSessionFile = path.join(tempDir, "parent.jsonl");
			const childSessionFile = path.join(tempDir, "child.jsonl");
			writeMinimalSessionFile(parentSessionFile, "parent");
			writeSessionJsonl(childSessionFile, signedForkEntries(parentSessionFile));
			const resolver = createForkContextResolver({
				getSessionFile: () => parentSessionFile,
				getLeafId: () => "assistant-1",
			}, "fork", {
				openSession: () => ({ createBranchedSession: () => childSessionFile }),
				forceThinkingOffForIndex: () => false,
			});

			assert.equal(resolver.thinkingOverrideForIndex(0), undefined);
			assert.equal(resolver.sanitizedForIndex(0), true);
			const entries = fs.readFileSync(childSessionFile, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
			// The unsafe block is still removed; only the blanket downgrade is skipped.
			assert.deepEqual(entries[2].message.content, [{ type: "text", text: "answer" }]);
			assert.ok(!entries.some((entry) => entry.type === "thinking_level_change"));
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("reports no sanitization for a fork without signed thinking blocks", () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-fork-clean-"));
		try {
			const parentSessionFile = path.join(tempDir, "parent.jsonl");
			const childSessionFile = path.join(tempDir, "child.jsonl");
			writeMinimalSessionFile(parentSessionFile, "parent");
			writeSessionJsonl(childSessionFile, [
				{ type: "session", version: 1, id: "child", timestamp: "2026-04-16T00:00:00.000Z", cwd: "/tmp", parentSession: parentSessionFile },
				{ type: "message", id: "user-1", parentId: null, timestamp: "2026-04-16T00:00:01.000Z", message: { role: "user", content: "prompt" } },
				{ type: "message", id: "assistant-1", parentId: "user-1", timestamp: "2026-04-16T00:00:02.000Z", message: { role: "assistant", provider: "vllm", api: "openai-completions", model: "vllm/cyankiwi-model", content: [{ type: "thinking", thinking: "open chain" }, { type: "text", text: "answer" }] } },
			]);
			const resolver = createForkContextResolver({
				getSessionFile: () => parentSessionFile,
				getLeafId: () => "assistant-1",
			}, "fork", {
				openSession: () => ({ createBranchedSession: () => childSessionFile }),
				forceThinkingOffForIndex: () => true,
			});

			assert.equal(resolver.sanitizedForIndex(0), false);
			assert.equal(resolver.thinkingOverrideForIndex(0), undefined);
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("reports no sanitization for a fresh context", () => {
		const resolver = createForkContextResolver({
			getSessionFile: () => undefined,
			getLeafId: () => null,
		}, "fresh");
		assert.equal(resolver.sanitizedForIndex(0), false);
	});
});
