import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	canContinueSameSessionAfterRateLimit,
	formatSubagentModelVerificationError,
	fuzzyResolveModel,
	isContextOverflow,
	isZeroProgressModelFailureAttempt,
	normalizeModelSegment,
	normalizeParentModel,
	resolveEffectiveSubagentModel,
	resolveModelCandidate,
	resolveModelSelection,
	resolveSameModelAccountFallbacks,
	resolveSubagentModelOverride,
	resolveZeroProgressFallbackModels,
} from "../../src/runs/shared/model-resolution.ts";
import { resolveModelScopesForAgent } from "../../src/runs/shared/model-scope.ts";

const models = [
	{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
	{ provider: "anthropic", id: "claude-sonnet-4", fullId: "anthropic/claude-sonnet-4" },
	{ provider: "openai", id: "shared", fullId: "openai/shared" },
	{ provider: "anthropic", id: "shared", fullId: "anthropic/shared" },
	{ provider: "huggingface", id: "org/model-v1", fullId: "huggingface/org/model-v1" },
];

describe("single model resolution", () => {
	it("resolves exactly one configured model and preserves thinking suffixes", () => {
		assert.deepEqual(resolveModelSelection("gpt-5-mini", models), {
			model: "openai/gpt-5-mini",
			requestedModel: "gpt-5-mini",
		});
		assert.equal(resolveModelCandidate("gpt-5-mini:high", models), "openai/gpt-5-mini:high");
	});

	it("inherits the current parent model for omitted, false, empty, and inherit values", () => {
		const parent = normalizeParentModel({ provider: "anthropic", id: "claude-sonnet-4" });
		for (const requested of [undefined, false, "", "  ", "inherit", " inherit "] as const) {
			assert.equal(resolveSubagentModelOverride(requested, parent, models), "anthropic/claude-sonnet-4");
		}
		assert.equal(resolveEffectiveSubagentModel(undefined, undefined, parent, models), "anthropic/claude-sonnet-4");
		assert.equal(resolveSubagentModelOverride("inherit", undefined, models), undefined);
	});

	it("resolves explicit models against the registry instead of the parent", () => {
		const parent = { provider: "anthropic", id: "claude-sonnet-4" };
		assert.equal(resolveSubagentModelOverride("gpt-5-mini", parent, models, undefined, { source: "explicit" }), "openai/gpt-5-mini");
		assert.equal(resolveSubagentModelOverride("openai/gpt-5-mini", parent, models, undefined, { source: "explicit" }), "openai/gpt-5-mini");
	});

	it("uses provider preference for ambiguous bare and owner/name ids", () => {
		assert.equal(resolveModelCandidate("shared", models), "shared");
		assert.equal(resolveModelCandidate("shared", models, "anthropic"), "anthropic/shared");
		assert.equal(resolveModelCandidate("org/model-v1", models), "huggingface/org/model-v1");
	});

	it("rejects unknown explicit/configured models and suggests a unique alternate provider", () => {
		assert.throws(
			() => resolveSubagentModelOverride("openai/claude-sonnet-4", undefined, models, undefined, { source: "explicit" }),
			/Unknown subagent model 'openai\/claude-sonnet-4'.*Did you mean 'anthropic\/claude-sonnet-4'/,
		);
		assert.throws(() => resolveModelSelection("missing", models), /Unknown subagent model 'missing'/);
		assert.equal(resolveEffectiveSubagentModel("missing", "gpt-5-mini", undefined, models, undefined, { source: "inherited" }), "missing");
	});

	it("normalizes registry spelling without switching a qualified provider", () => {
		assert.equal(normalizeModelSegment("GPT_5--MINI"), "gpt-5-mini");
		assert.equal(fuzzyResolveModel("GPT_5_MINI", models), "openai/gpt-5-mini");
		assert.equal(resolveModelCandidate("openai/claude-sonnet-4", models), "openai/claude-sonnet-4");
	});

	it("fuzzy matches case, separators, dates, and owner/name ids", () => {
		const registry = [
			{ provider: "openai", id: "GPT_5.Mini-2025-10-01", fullId: "openai/GPT_5.Mini-2025-10-01" },
			{ provider: "huggingface", id: "Org/Model_One", fullId: "huggingface/Org/Model_One" },
		];
		assert.equal(fuzzyResolveModel("gpt-5-mini", registry), "openai/GPT_5.Mini-2025-10-01");
		assert.equal(fuzzyResolveModel("openai/gpt-5-mini-20251001", registry), "openai/GPT_5.Mini-2025-10-01");
		assert.equal(fuzzyResolveModel("org/model-one", registry), "huggingface/Org/Model_One");
		assert.equal(fuzzyResolveModel("missing", registry), undefined);
	});

	it("enforces explicit and strict scopes while warning for inherited violations", () => {
		const scope = resolveModelScopesForAgent({ allow: ["anthropic/*"], enforce: true }, "worker", undefined);
		assert.throws(() => resolveModelSelection("openai/gpt-5-mini", models, undefined, { scope, origin: "explicit" }), /outside the configured subagent model scope/);
		const warnings: string[] = [];
		assert.equal(resolveSubagentModelOverride("openai/gpt-5-mini", undefined, models, undefined, {
			scope,
			source: "inherited",
			onWarn: (violation) => warnings.push(violation.message),
		}), "openai/gpt-5-mini");
		assert.equal(warnings.length, 1);
		const strict = resolveModelScopesForAgent({ allow: ["anthropic/*"], enforce: true, strict: true }, "worker", undefined);
		assert.throws(() => resolveModelSelection("openai/gpt-5-mini", models, undefined, { scope: strict, origin: "inherited" }), /outside the configured subagent model scope/);
	});

	it("resolves ordered different-model fallbacks for zero-progress retries", () => {
		const registry = [
			...models,
			{ provider: "devin", id: "swe-2", fullId: "devin/swe-2" },
		];
		assert.deepEqual(resolveZeroProgressFallbackModels(
			"openai/gpt-5-mini",
			["devin/swe-2:high", "anthropic/claude-sonnet-4", "openai/gpt-5-mini", "missing/model"],
			registry,
		), ["devin/swe-2:high", "anthropic/claude-sonnet-4"]);
		const strictScope = resolveModelScopesForAgent({ enforce: true, strict: true, allow: ["openai/*"] }, "worker", undefined);
		assert.throws(() => resolveZeroProgressFallbackModels(
			"openai/gpt-5-mini",
			["anthropic/claude-sonnet-4"],
			registry,
			undefined,
			{ scope: strictScope },
		), /outside the configured subagent model scope/);
	});

	it("keeps only configured exact-model account aliases for live continuation", () => {
		const registry = [
			...models,
			{ provider: "anthropic-2", id: "claude-sonnet-4", fullId: "anthropic-2/claude-sonnet-4" },
			{ provider: "anthropic-account-3", id: "claude-sonnet-4", fullId: "anthropic-account-3/claude-sonnet-4" },
			{ provider: "azure-openai-responses", id: "gpt-5-mini", fullId: "azure-openai-responses/gpt-5-mini" },
		];
		assert.deepEqual(resolveSameModelAccountFallbacks(
			"anthropic/claude-sonnet-4",
			["anthropic-2/claude-sonnet-4", "openai/gpt-5-mini", "anthropic-account-3/claude-sonnet-4", "missing/model"],
			registry,
		), ["anthropic-2/claude-sonnet-4", "anthropic-account-3/claude-sonnet-4"]);
		assert.deepEqual(resolveSameModelAccountFallbacks(
			"openai/gpt-5-mini",
			["azure-openai-responses/gpt-5-mini"],
			registry,
		), [], "provider families that merely share a model id are not interchangeable");
		const strictScope = resolveModelScopesForAgent({ enforce: true, strict: true, allow: ["anthropic/claude-sonnet-4"] }, "worker", undefined);
		assert.throws(() => resolveSameModelAccountFallbacks(
			"anthropic/claude-sonnet-4",
			["anthropic-2/claude-sonnet-4"],
			registry,
			undefined,
			{ scope: strictScope },
		), /outside the configured subagent model scope/);
	});

	it("fails closed when enforced inherit has no parent model", () => {
		const scope = resolveModelScopesForAgent({ allow: ["inherit"], enforce: true }, "worker", undefined);
		assert.throws(() => resolveModelSelection(undefined, models, undefined, { scope }), /'inherit' requires a current parent session model/);
	});
});

describe("zero-progress fallback admission", () => {
	it("admits terminal provider errors including HTTP 401 before output or tools", () => {
		const error = "OpenAI API error (401): invalid_api_key";
		assert.equal(isZeroProgressModelFailureAttempt({
			error,
			toolCount: 0,
			messages: [{ role: "assistant", content: [], stopReason: "error", errorMessage: error }],
		}), true);
		assert.equal(isZeroProgressModelFailureAttempt({ error: "model_verification_failed: wrong route", messages: [], toolCount: 0 }), true);
		assert.equal(isZeroProgressModelFailureAttempt({
			error: "novel provider failure",
			messages: [{ role: "assistant", content: [], stopReason: "error", errorMessage: "novel provider failure" }],
			toolCount: 0,
		}), true);
	});

	it("rejects useful output, tool history, and tool-originated failures", () => {
		assert.equal(isZeroProgressModelFailureAttempt({
			error: "401 invalid_api_key",
			toolCount: 0,
			messages: [{ role: "assistant", content: [{ type: "text", text: "partial" }], stopReason: "error", errorMessage: "401 invalid_api_key" }],
		}), false);
		assert.equal(isZeroProgressModelFailureAttempt({ error: "401 invalid_api_key", messages: [], toolCount: 1 }), false);
		assert.equal(isZeroProgressModelFailureAttempt({ error: "bash failed (exit 1): network error", messages: [], toolCount: 0 }), false);
		assert.equal(isZeroProgressModelFailureAttempt({
			error: "401 invalid_api_key",
			toolCount: 0,
			messages: [
				{ role: "user", content: [{ type: "text", text: "Task: original" }] },
				{ role: "user", content: [{ type: "text", text: "Steer: revised scope" }] },
				{ role: "assistant", content: [], stopReason: "error", errorMessage: "401 invalid_api_key" },
			],
		}), false);
	});
});

describe("same-session continuation admission", () => {
	const complete = [
		{ role: "assistant", content: [{ type: "toolCall", id: "write-1" }] },
		{ role: "toolResult", toolCallId: "write-1", isError: false },
		{ role: "assistant", content: [], stopReason: "error", errorMessage: "429 rate limit" },
	];
	const base = {
		currentModel: "anthropic/claude-sonnet-4",
		nextModel: "anthropic-2/claude-sonnet-4",
		error: "429 rate limit",
		toolCount: 1,
	};

	it("admits only a fully paired successful tool history with the trusted terminal error", () => {
		assert.equal(canContinueSameSessionAfterRateLimit({ ...base, messages: complete }), true);
		assert.equal(canContinueSameSessionAfterRateLimit({ ...base, messages: complete.slice(0, 1) }), false);
		assert.equal(canContinueSameSessionAfterRateLimit({ ...base, messages: [complete[0], { role: "toolResult", toolCallId: "write-1", isError: true }, complete[2]] }), false);
	});

	it("vetoes cancellation, active tools, budgets, structured output, and cross-provider routes", () => {
		for (const extra of [{ cancelled: true }, { currentTool: "write" }, { budgetExhausted: true }, { structuredOutputInvoked: true }]) {
			assert.equal(canContinueSameSessionAfterRateLimit({ ...base, messages: complete, ...extra }), false);
		}
		assert.equal(canContinueSameSessionAfterRateLimit({ ...base, nextModel: "azure-openai-responses/claude-sonnet-4", messages: complete }), false);
	});
});

describe("model response identity", () => {
	it("accepts exact, bare, leaf, and declared alias response ids", () => {
		assert.equal(formatSubagentModelVerificationError("openai/gpt-5-mini:high", "gpt-5-mini", models), undefined);
		assert.equal(formatSubagentModelVerificationError("huggingface/org/model-v1", "model-v1", models), undefined);
		assert.equal(formatSubagentModelVerificationError("openai/gpt-5-mini", "gateway-model", models, {
			"openai/gpt-5-mini": ["gateway-model"],
		}), undefined);
	});

	it("rejects a different response route and does not apply another model's alias", () => {
		assert.match(formatSubagentModelVerificationError("openai/gpt-5-mini", "anthropic/claude-sonnet-4", models) ?? "", /model_verification_failed/);
		assert.match(formatSubagentModelVerificationError("openai/gpt-5-mini", "gateway-model", models, {
			"anthropic/claude-sonnet-4": ["gateway-model"],
		}) ?? "", /model_verification_failed/);
	});
});

describe("context overflow classification", () => {
	it("detects common context overflow errors", () => {
		for (const error of ["maximum context length exceeded", "context window overflow", "too many tokens", "context_length_exceeded", "input too long"]) {
			assert.equal(isContextOverflow(error), true, error);
		}
	});

	it("does not classify tool failures, provider failures, or empty input as overflow", () => {
		assert.equal(isContextOverflow("bash failed (exit 1): input too long"), false);
		assert.equal(isContextOverflow("429 rate limit exceeded"), false);
		assert.equal(isContextOverflow(undefined), false);
	});
});
