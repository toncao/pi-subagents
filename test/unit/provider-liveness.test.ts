import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { buildModelCandidates } from "../../src/runs/shared/model-fallback.ts";
import { clearExclusions, findModelExclusion, recordModelFailure } from "../../src/runs/shared/model-exclusions.ts";
import { getProviderLiveness, resetProviderLivenessCache } from "../../src/runs/shared/provider-liveness.ts";

const MINUTE = 60_000;

const availableModels = [
	{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
	{ provider: "anthropic", id: "claude-sonnet-4", fullId: "anthropic/claude-sonnet-4" },
];

let agentDir: string;
let previousAgentDir: string | undefined;

/** Publish a `pi-multi-account`-shaped state file into the isolated agent dir. */
function publishState(state: unknown): void {
	fs.writeFileSync(path.join(agentDir, "provider-failover-state.json"), JSON.stringify(state), "utf-8");
	resetProviderLivenessCache();
}

function freshUsage(provider: string, snapshot: Record<string, unknown>, fetchedAt = Date.now()) {
	return { usageByProvider: { [provider]: { fetchedAt, ...snapshot } } };
}

beforeEach(() => {
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-liveness-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	resetProviderLivenessCache();
	clearExclusions();
});

afterEach(() => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	resetProviderLivenessCache();
	clearExclusions();
	fs.rmSync(agentDir, { recursive: true, force: true });
});

describe("provider liveness (reads pi-multi-account published state)", () => {
	it("reports unknown when the companion publishes nothing", () => {
		assert.equal(getProviderLiveness("anthropic"), "unknown");
	});

	it("caches a missing state file for the read TTL", () => {
		const now = Date.now();
		assert.equal(getProviderLiveness("anthropic", now), "unknown");
		fs.writeFileSync(
			path.join(agentDir, "provider-failover-state.json"),
			JSON.stringify(freshUsage("anthropic", { serviceable: true }, now)),
			"utf-8",
		);
		assert.equal(getProviderLiveness("anthropic", now + 1), "unknown");
		assert.equal(getProviderLiveness("anthropic", now + 5_001), "live");
	});

	it("reports unknown for unparseable or partially written state", () => {
		fs.writeFileSync(path.join(agentDir, "provider-failover-state.json"), '{"usageByProvider":', "utf-8");
		resetProviderLivenessCache();
		assert.equal(getProviderLiveness("anthropic"), "unknown");
	});

	it("treats the account's own serviceable verdict as live", () => {
		publishState(freshUsage("anthropic", { serviceable: true, primary: { usedPercent: 100 } }));
		assert.equal(getProviderLiveness("anthropic"), "live");
	});

	it("treats an explicit serviceable=false as blocked even with quota headroom", () => {
		publishState(freshUsage("anthropic", { serviceable: false, primary: { usedPercent: 0 } }));
		assert.equal(getProviderLiveness("anthropic"), "blocked");
	});

	it("derives liveness from the primary window when no verdict is stated", () => {
		publishState(freshUsage("anthropic", { primary: { usedPercent: 2 } }));
		assert.equal(getProviderLiveness("anthropic"), "live");
		publishState(freshUsage("anthropic", { primary: { usedPercent: 100 } }));
		assert.equal(getProviderLiveness("anthropic"), "blocked");
	});

	it("honours a recorded cooldown when the account states no verdict", () => {
		publishState({
			...freshUsage("anthropic", { primary: { usedPercent: 0 } }),
			exhaustedUntilByProvider: { anthropic: Date.now() + 10 * MINUTE },
		});
		assert.equal(getProviderLiveness("anthropic"), "blocked");
	});

	it("lets the account's serviceable verdict outrank a recorded cooldown", () => {
		publishState({
			...freshUsage("anthropic", { serviceable: true }),
			exhaustedUntilByProvider: { anthropic: Date.now() + 10 * MINUTE },
		});
		assert.equal(getProviderLiveness("anthropic"), "live");
	});

	it("ignores an elapsed cooldown", () => {
		publishState({
			...freshUsage("anthropic", { primary: { usedPercent: 5 } }),
			exhaustedUntilByProvider: { anthropic: Date.now() - MINUTE },
		});
		assert.equal(getProviderLiveness("anthropic"), "live");
	});

	it("reports blocked for an invalidated credential regardless of quota", () => {
		publishState({
			...freshUsage("anthropic", { serviceable: true, primary: { usedPercent: 0 } }),
			invalidatedByProvider: { anthropic: Date.now() + 10 * MINUTE },
		});
		assert.equal(getProviderLiveness("anthropic"), "blocked");
	});

	it("treats a stale snapshot as unknown rather than evidence", () => {
		publishState({ usageByProvider: { anthropic: { fetchedAt: Date.now() - 60 * MINUTE, serviceable: true } } });
		assert.equal(getProviderLiveness("anthropic"), "unknown");
	});

	it("reports unknown for a provider absent from the published state", () => {
		publishState(freshUsage("anthropic", { serviceable: true }));
		assert.equal(getProviderLiveness("openai"), "unknown");
	});
});

describe("cached limit exclusions defer to live provider state", () => {
	const limitReason = '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit."}}';

	it("skips a limit-class exclusion whose account is serving again", () => {
		recordModelFailure({ modelId: "gpt-5-mini", provider: "openai", reason: limitReason });
		const exclusion = findModelExclusion("openai/gpt-5-mini");
		assert.ok(exclusion);
		publishState(freshUsage("openai", { serviceable: true }, exclusion.recordedAt + 1));
		assert.deepEqual(
			buildModelCandidates("openai/gpt-5-mini", ["anthropic/claude-sonnet-4"], availableModels),
			["openai/gpt-5-mini", "anthropic/claude-sonnet-4"],
		);
	});

	it("keeps a limit exclusion when the live snapshot predates the refusal", () => {
		recordModelFailure({ modelId: "gpt-5-mini", provider: "openai", reason: limitReason });
		const exclusion = findModelExclusion("openai/gpt-5-mini");
		assert.ok(exclusion);
		publishState(freshUsage("openai", { serviceable: true }, exclusion.recordedAt - 1));
		assert.deepEqual(
			buildModelCandidates("openai/gpt-5-mini", ["anthropic/claude-sonnet-4"], availableModels),
			["anthropic/claude-sonnet-4"],
		);
	});

	it("keeps a limit-class exclusion while the account is still blocked", () => {
		recordModelFailure({ modelId: "gpt-5-mini", provider: "openai", reason: limitReason });
		publishState(freshUsage("openai", { primary: { usedPercent: 100 } }));
		assert.deepEqual(
			buildModelCandidates("openai/gpt-5-mini", ["anthropic/claude-sonnet-4"], availableModels),
			["anthropic/claude-sonnet-4"],
		);
	});

	it("keeps a limit-class exclusion when no companion state is published", () => {
		recordModelFailure({ modelId: "gpt-5-mini", provider: "openai", reason: limitReason });
		assert.deepEqual(
			buildModelCandidates("openai/gpt-5-mini", ["anthropic/claude-sonnet-4"], availableModels),
			["anthropic/claude-sonnet-4"],
		);
	});

	it("does not relax a non-limit exclusion for a live account", () => {
		recordModelFailure({ modelId: "gpt-5-mini", provider: "openai", reason: "sk-secret-token-xyz" });
		publishState(freshUsage("openai", { serviceable: true }));
		assert.deepEqual(
			buildModelCandidates("openai/gpt-5-mini", ["anthropic/claude-sonnet-4"], availableModels),
			["anthropic/claude-sonnet-4"],
		);
	});

	it("launches an explicitly pinned model whose limit exclusion has recovered", () => {
		recordModelFailure({ modelId: "gpt-5-mini", provider: "openai", reason: limitReason });
		const exclusion = findModelExclusion("openai/gpt-5-mini");
		assert.ok(exclusion);
		publishState(freshUsage("openai", { serviceable: true }, exclusion.recordedAt + 1));
		assert.deepEqual(
			buildModelCandidates("openai/gpt-5-mini", [], availableModels, undefined, { origin: "explicit" }),
			["openai/gpt-5-mini"],
		);
	});

	it("still fails an explicitly pinned model while its account is blocked", () => {
		recordModelFailure({ modelId: "gpt-5-mini", provider: "openai", reason: limitReason });
		publishState(freshUsage("openai", { primary: { usedPercent: 100 } }));
		assert.throws(
			() => buildModelCandidates("openai/gpt-5-mini", ["anthropic/claude-sonnet-4"], availableModels, undefined, { origin: "explicit" }),
			/Requested subagent model 'openai\/gpt-5-mini' is excluded and cannot be replaced by a fallback/,
		);
	});

	it("keeps explicit model-not-found exclusions strict even for a live account", () => {
		recordModelFailure({
			modelId: "gpt-5-mini",
			provider: "openai",
			reason: 'Model "openai/gpt-5-mini" not found. Use --list-models to see available models.',
		});
		publishState(freshUsage("openai", { serviceable: true }));
		assert.throws(
			() => buildModelCandidates("openai/gpt-5-mini", ["anthropic/claude-sonnet-4"], availableModels, undefined, { origin: "explicit" }),
			/Requested subagent model 'openai\/gpt-5-mini' is excluded and cannot be replaced by a fallback/,
		);
	});

	it("recovers every account of a provider family independently", () => {
		recordModelFailure({ modelId: "claude-opus-5", provider: "anthropic", reason: limitReason });
		recordModelFailure({ modelId: "claude-opus-5", provider: "anthropic-2", reason: limitReason });
		const models = [
			{ provider: "anthropic", id: "claude-opus-5", fullId: "anthropic/claude-opus-5" },
			{ provider: "anthropic-2", id: "claude-opus-5", fullId: "anthropic-2/claude-opus-5" },
		];
		publishState({
			usageByProvider: {
				anthropic: { fetchedAt: Date.now(), primary: { usedPercent: 2 } },
				"anthropic-2": { fetchedAt: Date.now(), primary: { usedPercent: 100 } },
			},
		});
		assert.deepEqual(
			buildModelCandidates("anthropic-2/claude-opus-5", ["anthropic/claude-opus-5"], models),
			["anthropic/claude-opus-5"],
		);
	});
});
