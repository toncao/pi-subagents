import { splitKnownThinkingSuffix as splitThinkingSuffix, splitKnownThinkingSuffix, findModelInfo, type ModelInfo as AvailableModelInfo } from "../../shared/model-info.ts";
import { checkModelScope, type ModelScopeCheckRule, type ModelScopeViolation, type ModelSource } from "./model-scope.ts";

export type { AvailableModelInfo };

export interface ModelSelectionEvidence {
	model?: string;
	requestedModel?: string;
}

export { splitThinkingSuffix };

/** Decide whether a resolved child model uses Anthropic's provider or message API, which
 * requires the sanitized fork to disable thinking. Unknown models stay conservative. */
export function forkedChildRequiresThinkingOff(
	model: string | undefined,
	availableModels?: AvailableModelInfo[],
	preferredProvider?: string,
): boolean {
	if (!model) return true;
	const info = findModelInfo(model, availableModels, preferredProvider);
	if (!info) return true;
	return info.provider.toLowerCase() === "anthropic"
		|| info.api?.toLowerCase() === "anthropic-messages";
}

/** Pin `:off` onto only the candidates that cannot resume a sanitized fork with thinking.
 *
 * A sanitized fork had signed/redacted Anthropic thinking blocks stripped, which only
 * Anthropic's message API rejects on replay. Forcing the whole candidate chain to `off`
 * because one fallback is Anthropic silently disables reasoning for unrelated providers,
 * so mark each candidate individually and leave the rest on their configured level.
 * The suffix is authoritative at launch and across fallback switches, because
 * `resolveEffectiveThinking` prefers a candidate's own suffix over the step thinking. */
export function applyForkThinkingToModel(
	model: string | undefined,
	options: { sanitized: boolean; availableModels?: AvailableModelInfo[]; preferredProvider?: string },
): string | undefined {
	if (!model) return model;
	return applyForkThinkingToCandidates([model], options)[0] ?? model;
}

export function applyForkThinkingToCandidates(
	candidates: string[],
	options: { sanitized: boolean; availableModels?: AvailableModelInfo[]; preferredProvider?: string },
): string[] {
	if (!options.sanitized) return candidates;
	return candidates.map((candidate) => {
		if (!forkedChildRequiresThinkingOff(candidate, options.availableModels, options.preferredProvider)) return candidate;
		return `${splitKnownThinkingSuffix(candidate).baseModel}:off`;
	});
}

/** Aliases apply only to the resolved launch candidate (without its thinking suffix) and the exact raw response ID. */
export function formatSubagentModelVerificationError(
	expectedModel: string,
	observedModel: string,
	availableModels: AvailableModelInfo[] | undefined,
	modelResponseAliases?: Record<string, string[]>,
): string | undefined {
	if (!availableModels || availableModels.length === 0) return undefined;
	const expectedBase = splitThinkingSuffix(expectedModel).baseModel;
	if (modelResponseAliases && Object.hasOwn(modelResponseAliases, expectedBase)
		&& modelResponseAliases[expectedBase]?.includes(observedModel)) return undefined;
	const observedBase = splitThinkingSuffix(observedModel).baseModel;
	if (expectedBase === observedBase) return undefined;
	const expectedEntry = availableModels.find((entry) => entry.fullId === expectedBase);
	if (expectedEntry) {
		if (expectedEntry.id === observedBase) return undefined;
		const expectedIdLeaf = expectedEntry.id.slice(expectedEntry.id.lastIndexOf("/") + 1);
		const expectedFullIdLeaf = expectedEntry.fullId.slice(expectedEntry.fullId.lastIndexOf("/") + 1);
		if (expectedIdLeaf === observedBase || expectedFullIdLeaf === observedBase) return undefined;
	}
	return `model_verification_failed: native Pi child reported a different model than the launch candidate. Expected '${expectedModel}' but observed '${observedModel}'. If you have independently verified this response ID identifies the requested model, declare the exact mapping in modelResponseAliases in ~/.pi/agent/extensions/subagent/config.json (see docs/configuration.md#modelresponsealiases). Use the resolved provider/model ID without its thinking suffix as the key. This leaves the outgoing request unchanged. Configuration changes affect new independent native runs; resumed native runs retain their launch-time declaration. External CLI adapters do not use this setting.`;
}

/** Sentinel model value requesting that a subagent inherit the parent session's model. */
export const INHERIT_MODEL = "inherit";

/** Minimal shape of the parent session's in-memory model (`ctx.model`). */
export interface ParentModel {
	provider: string;
	id: string;
}

export function normalizeParentModel(model: unknown): ParentModel | undefined {
	if (!model || typeof model !== "object") return undefined;
	const candidate = model as { provider?: unknown; id?: unknown };
	if (typeof candidate.provider !== "string" || typeof candidate.id !== "string") return undefined;
	if (!candidate.provider || !candidate.id) return undefined;
	return { provider: candidate.provider, id: candidate.id };
}

/**
 * Normalize a model id or provider segment for fuzzy comparison: case-fold,
 * treat dots/underscores as dashes (so `4.5` matches `4-5`), and collapse
 * repeated separators.
 */
export function normalizeModelSegment(segment: string): string {
	return segment
		.toLowerCase()
		.replace(/[._]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
}

function isPlausibleDateStamp(year: string, month: string, day: string): boolean {
	const yyyy = Number(year);
	const mm = Number(month);
	const dd = Number(day);
	return yyyy >= 1900 && yyyy <= 2099 && mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31;
}

/** Drop a trailing date stamp (`-20251001` or `-2025-10-01`) so dated and undated ids match. */
function stripTrailingDateStamp(segment: string): string {
	const dashed = /^(.*)-(\d{4})-(\d{2})-(\d{2})$/.exec(segment);
	if (dashed && isPlausibleDateStamp(dashed[2]!, dashed[3]!, dashed[4]!)) return dashed[1]!;
	const compact = /^(.*)-(\d{4})(\d{2})(\d{2})$/.exec(segment);
	if (compact && isPlausibleDateStamp(compact[2]!, compact[3]!, compact[4]!)) return compact[1]!;
	return segment;
}

function isRegisteredProvider(provider: string, availableModels: AvailableModelInfo[]): boolean {
	const normalized = normalizeModelSegment(provider);
	return availableModels.some((entry) => normalizeModelSegment(entry.provider) === normalized);
}

/**
 * Split `provider/id` only when the first path segment is a registered provider.
 * Hugging Face-style `owner/name` ids therefore stay intact unless `owner` is
 * itself a provider in the active registry. `:` and `.` keep the same rule.
 */
function splitQualifiedModelQuery(
	baseModel: string,
	availableModels: AvailableModelInfo[],
): { queryProvider?: string; queryIdRaw: string } {
	const slashIdx = baseModel.indexOf("/");
	if (slashIdx !== -1) {
		const providerPart = baseModel.slice(0, slashIdx);
		if (isRegisteredProvider(providerPart, availableModels)) {
			return { queryProvider: normalizeModelSegment(providerPart), queryIdRaw: baseModel.slice(slashIdx + 1) };
		}
		return { queryIdRaw: baseModel };
	}
	const providerSeparators = [":", "."];
	for (const separator of providerSeparators) {
		const separatorIdx = baseModel.indexOf(separator);
		if (separatorIdx <= 0) continue;
		const providerPart = baseModel.slice(0, separatorIdx);
		if (!isRegisteredProvider(providerPart, availableModels)) continue;
		return { queryProvider: normalizeModelSegment(providerPart), queryIdRaw: baseModel.slice(separatorIdx + 1) };
	}
	return { queryIdRaw: baseModel };
}

function resolveExactIdMatches(
	baseModel: string,
	availableModels: AvailableModelInfo[],
	preferredProvider?: string,
): string | undefined {
	const exactMatches = availableModels.filter((entry) => entry.id === baseModel);
	if (preferredProvider) {
		const preferredMatch = exactMatches.find((entry) => entry.provider === preferredProvider);
		if (preferredMatch) return preferredMatch.fullId;
	}
	if (exactMatches.length === 1) return exactMatches[0]!.fullId;
	return undefined;
}

function resolveBaseModelCandidate(
	baseModel: string,
	availableModels: AvailableModelInfo[],
	preferredProvider?: string,
): string | undefined {
	const exact = availableModels.find((entry) => entry.fullId === baseModel);
	if (exact) return exact.fullId;

	const { queryProvider } = splitQualifiedModelQuery(baseModel, availableModels);
	// A provider can register ids that already contain its own namespace, e.g.
	// provider=devin, id=devin/swe-2. Accept that exact catalog id, but keep a
	// registered provider prefix binding: never route it to another provider.
	const exactIdModels = queryProvider === undefined
		? availableModels
		: availableModels.filter((entry) => normalizeModelSegment(entry.provider) === queryProvider);
	const exactId = resolveExactIdMatches(baseModel, exactIdModels, preferredProvider);
	if (exactId) return exactId;

	return fuzzyResolveModel(baseModel, availableModels, preferredProvider);
}

/**
 * Fuzzy-resolve a base model id (thinking suffix already stripped) against the
 * registry, tolerating separator, case, and optional date-stamp differences so
 * users do not have to spell provider/model exactly. A slash is a provider
 * prefix only when that prefix is a registered provider; otherwise the whole
 * string is the model id (Hugging Face `owner/name`). A qualified provider
 * query only matches within the named provider — this never silently switches
 * providers for security/cost-sensitive configs. Returns the matched `fullId`,
 * or `undefined` when there is no match or the match is ambiguous across
 * providers (and no `preferredProvider` disambiguates).
 */
export function fuzzyResolveModel(
	baseModel: string,
	availableModels: AvailableModelInfo[],
	preferredProvider?: string,
): string | undefined {
	const { queryProvider, queryIdRaw } = splitQualifiedModelQuery(baseModel, availableModels);
	const queryId = normalizeModelSegment(queryIdRaw);
	const queryIdNoDate = stripTrailingDateStamp(queryId);

	const candidates = availableModels.filter((entry) => {
		const entryId = normalizeModelSegment(entry.id);
		if (entryId !== queryId && stripTrailingDateStamp(entryId) !== queryIdNoDate) return false;
		if (queryProvider !== undefined && normalizeModelSegment(entry.provider) !== queryProvider) return false;
		return true;
	});
	if (candidates.length === 0) return undefined;
	if (preferredProvider) {
		const preferredProviderNorm = normalizeModelSegment(preferredProvider);
		const preferred = candidates.find((entry) => normalizeModelSegment(entry.provider) === preferredProviderNorm);
		if (preferred) return preferred.fullId;
	}
	if (candidates.length === 1) return candidates[0]!.fullId;
	return undefined;
}

/**
 * Resolve a possibly-loose model id to a canonical `provider/id` (plus any
 * thinking suffix). Exact registry matches win; fuzzy normalization
 * (separator/case/date-stamp via {@link fuzzyResolveModel}) is a fallback so
 * spelling differences still resolve. Never switches providers for a qualified
 * query.
 */
export function resolveModelCandidate(
	model: string | undefined,
	availableModels: AvailableModelInfo[] | undefined,
	preferredProvider?: string,
): string | undefined {
	if (!model) return undefined;
	if (!availableModels || availableModels.length === 0) return model;

	const resolvedWhole = resolveBaseModelCandidate(model, availableModels, preferredProvider);
	if (resolvedWhole) return resolvedWhole;

	const { baseModel, thinkingSuffix } = splitThinkingSuffix(model);
	if (!thinkingSuffix) return model;
	const resolvedBase = resolveBaseModelCandidate(baseModel, availableModels, preferredProvider);
	if (resolvedBase) return `${resolvedBase}${thinkingSuffix}`;
	return model;
}

function resolveSubagentModelCandidate(
	model: string,
	availableModels: AvailableModelInfo[] | undefined,
	preferredProvider?: string,
): string | undefined {
	if (!availableModels || availableModels.length === 0) return model;
	const resolvedWhole = resolveBaseModelCandidate(model, availableModels, preferredProvider);
	if (resolvedWhole) return resolvedWhole;
	const { baseModel, thinkingSuffix } = splitThinkingSuffix(model);
	const resolvedBase = thinkingSuffix ? resolveBaseModelCandidate(baseModel, availableModels, preferredProvider) : undefined;
	return resolvedBase ? `${resolvedBase}${thinkingSuffix}` : undefined;
}

function suggestAlternateProviderModel(
	model: string,
	availableModels: AvailableModelInfo[] | undefined,
): string | undefined {
	if (!availableModels || availableModels.length === 0) return undefined;
	const { baseModel, thinkingSuffix } = splitThinkingSuffix(model);
	const { queryProvider, queryIdRaw } = splitQualifiedModelQuery(baseModel, availableModels);
	if (queryProvider === undefined) return undefined;
	const suggestion = resolveBaseModelCandidate(queryIdRaw, availableModels);
	if (!suggestion) return undefined;
	const matched = availableModels.find((entry) => entry.fullId === suggestion);
	if (!matched || normalizeModelSegment(matched.provider) === queryProvider) return undefined;
	return `${suggestion}${thinkingSuffix}`;
}

function resolveRequiredSubagentModelCandidate(
	model: string,
	availableModels: AvailableModelInfo[] | undefined,
	preferredProvider?: string,
): string {
	const resolved = resolveSubagentModelCandidate(model, availableModels, preferredProvider);
	if (resolved) return resolved;
	const suggestion = suggestAlternateProviderModel(model, availableModels);
	throw new Error(
		`Unknown subagent model '${model}' in the active Pi model registry.${suggestion ? ` Did you mean '${suggestion}'?` : ""}`,
	);
}

export interface ResolveSubagentModelOverrideOptions {
	/** When set with `enforce: true`, out-of-scope models are rejected. */
	scope?: ModelScopeCheckRule | ModelScopeCheckRule[];
	/** Origin of the requested model: explicit caller-supplied (hard error) vs inherited (warn). Defaults to `"inherited"`. */
	source?: ModelSource;
	/** Called for warn-severity violations instead of `console.warn`. */
	onWarn?: (violation: ModelScopeViolation) => void;
}

function defaultScopeWarn(violation: ModelScopeViolation): void {
	console.warn(`[pi-subagents] ${violation.message}`);
}

function configuredScopes(scope: ModelScopeCheckRule | ModelScopeCheckRule[] | undefined): ModelScopeCheckRule[] {
	return scope ? (Array.isArray(scope) ? scope : [scope]) : [];
}

function throwForUnresolvedEnforcedInheritScope(scope: ModelScopeCheckRule | ModelScopeCheckRule[] | undefined, includeMixed = false): void {
	const unresolvedInheritScope = configuredScopes(scope)
		.find((entry) => entry.enforce === true && (includeMixed ? entry.allow?.includes(INHERIT_MODEL) : entry.allow?.length === 1 && entry.allow[0] === INHERIT_MODEL));
	if (!unresolvedInheritScope) return;
	const origin = unresolvedInheritScope.origin ?? "modelScope";
	throw new Error(`Cannot enforce subagent model scope (${origin}): 'inherit' requires a current parent session model.`);
}

function enforceModelScopes(
	model: string,
	scope: ModelScopeCheckRule | ModelScopeCheckRule[] | undefined,
	source: ModelSource,
	onWarn: ((violation: ModelScopeViolation) => void) | undefined,
): void {
	const violations = configuredScopes(scope)
		.map((entry) => checkModelScope(model, entry, source))
		.filter((violation): violation is ModelScopeViolation => violation !== undefined);
	const error = violations.find((violation) => violation.severity === "error");
	if (error) throw new Error(error.message);
	for (const violation of violations) (onWarn ?? defaultScopeWarn)(violation);
}

/**
 * Resolve the `--model` override passed to a spawned subagent.
 *
 * When no model is requested (`undefined`, `false`, empty, or the `"inherit"`
 * sentinel), the child must inherit the parent session's *in-memory* model
 * (`provider/id`) instead of being left to resolve its own model. Without an
 * explicit `provider/id`, the child falls back to the global
 * `~/.pi/agent/settings.json` default, which is shared across every open PI
 * session — so a different session that last changed its model in the TUI would
 * silently contaminate this session's subagents (see issue #266). Passing an
 * explicit `provider/id` keeps each session's children isolated to that
 * session's model.
 *
 * An explicitly requested model string is resolved via {@link resolveModelCandidate}.
 * When `options.scope.enforce` is on, an out-of-scope resolved model throws for
 * an explicit (`source: "explicit"`) request and warns for an inherited one,
 * unless strict scope enforcement makes inherited violations hard errors.
 */
export function resolveSubagentModelOverride(
	requestedModel: string | boolean | undefined,
	parentModel: ParentModel | undefined,
	availableModels: AvailableModelInfo[] | undefined,
	preferredProvider?: string,
	options?: ResolveSubagentModelOverrideOptions,
): string | undefined {
	const trimmed = typeof requestedModel === "string" ? requestedModel.trim() : "";
	const explicit = trimmed && trimmed !== INHERIT_MODEL ? trimmed : undefined;
	if (!parentModel) throwForUnresolvedEnforcedInheritScope(options?.scope, explicit === undefined || options?.source === "inherited");
	let resolved: string | undefined;
	let resolvedFromRegistry = explicit === undefined;
	if (explicit === undefined) {
		resolved = parentModel ? `${parentModel.provider}/${parentModel.id}` : undefined;
	} else {
		const candidate = resolveSubagentModelCandidate(explicit, availableModels, preferredProvider);
		if (options?.source === "explicit") {
			resolved = candidate ?? resolveRequiredSubagentModelCandidate(explicit, availableModels, preferredProvider);
			resolvedFromRegistry = true;
		} else if (candidate) {
			resolved = candidate;
			resolvedFromRegistry = true;
		} else {
			resolved = explicit;
		}
	}
	if (resolved && options?.scope && resolvedFromRegistry) {
		const source: ModelSource = explicit === undefined ? "inherited" : (options.source ?? "inherited");
		enforceModelScopes(resolved, options.scope, source, options.onWarn);
	}
	return resolved;
}

export function resolveEffectiveSubagentModel(
	explicitModel: string | boolean | undefined,
	agentModel: string | boolean | undefined,
	parentModel: ParentModel | undefined,
	availableModels: AvailableModelInfo[] | undefined,
	preferredProvider?: string,
	options?: ResolveSubagentModelOverrideOptions,
): string | undefined {
	const source = options?.source ?? (explicitModel !== undefined ? "explicit" : "inherited");
	const resolved = resolveSubagentModelOverride(
		explicitModel ?? agentModel,
		parentModel,
		availableModels,
		preferredProvider,
		{ ...options, source },
	);
	if (resolved || explicitModel === undefined) return resolved;
	return resolveSubagentModelOverride(
		agentModel,
		parentModel,
		availableModels,
		preferredProvider,
		{ ...options, source: options?.source ?? "inherited" },
	);
}

export type ModelOrigin = ModelSource | "configured";

export interface ResolveModelSelectionOptions {
	scope?: ModelScopeCheckRule | ModelScopeCheckRule[];
	onWarn?: (violation: ModelScopeViolation) => void;
	/** The primary model came from the running parent session, not configuration. */
	primaryModelFromParent?: boolean;
	/** How the model was selected. */
	origin?: ModelOrigin;
}

export function resolveModelOrigin(input: {
	explicitModel?: string | boolean;
	agentModel?: string | boolean;
	parentModel?: ParentModel;
	fromParent?: boolean;
	storedOrigin?: ModelOrigin;
}): ModelOrigin {
	if (input.storedOrigin) return input.storedOrigin;
	if (input.fromParent) return "inherited";
	if (inheritsParentModel(input.explicitModel, input.agentModel, input.parentModel)) return "inherited";
	const trimmed = typeof input.explicitModel === "string" ? input.explicitModel.trim() : "";
	return trimmed && trimmed !== INHERIT_MODEL ? "explicit" : "configured";
}

export function inheritsParentModel(
	explicitModel: string | boolean | undefined,
	agentModel: string | boolean | undefined,
	parentModel: ParentModel | undefined,
): boolean {
	const requestedModel = explicitModel ?? agentModel;
	const trimmed = typeof requestedModel === "string" ? requestedModel.trim() : "";
	return Boolean(parentModel && (!trimmed || trimmed === INHERIT_MODEL));
}

export function resolveModelSelection(
	model: string | undefined,
	availableModels: AvailableModelInfo[] | undefined,
	preferredProvider?: string,
	options?: ResolveModelSelectionOptions,
): ModelSelectionEvidence {
	if (!model) throwForUnresolvedEnforcedInheritScope(options?.scope, true);
	const origin = options?.origin ?? (options?.primaryModelFromParent ? "inherited" : "configured");
	const requestedModel = origin === "inherited" ? undefined : model;
	const scopes = configuredScopes(options?.scope);
	if (origin === "explicit" && model) {
		const normalized = resolveRequiredSubagentModelCandidate(model.trim(), availableModels, preferredProvider);
		enforceModelScopes(normalized, scopes, "explicit", options?.onWarn);
		model = normalized;
	}
	const resolved = model && (origin === "inherited" || origin === "explicit" || options?.primaryModelFromParent)
		? model.trim()
		: model ? resolveRequiredSubagentModelCandidate(model.trim(), availableModels, preferredProvider) : undefined;
	if (resolved && scopes.some((scope) => scope.enforce === true && scope.strict === true)) {
		enforceModelScopes(resolved, scopes, "inherited", options?.onWarn);
	}
	return { ...(resolved ? { model: resolved } : {}), ...(requestedModel ? { requestedModel } : {}) };
}

// Request-shape failures can match broad fallback signals such as "upstream",
// but do not establish that the model is unhealthy for subsequent requests.
const REQUEST_SHAPE_FAILURE_PATTERN = /\b(?:bad[ _]request|invalid[ _]argument|invalid_request_error)\b/i;

/** A deliberately small user message: the existing transcript carries the task and completed tool results. */
export const SAME_SESSION_ACCOUNT_FALLBACK_NOTICE =
	"The previous account reached a runtime rate or quota limit. Continue the same task from the existing conversation and completed tool results. Do not repeat completed tool calls or redo completed work.";

function parseModelKey(fullId: string): { provider?: string; modelId: string } {
	const trimmed = splitThinkingSuffix(fullId.trim()).baseModel;
	const slash = trimmed.indexOf("/");
	if (slash === -1) return { modelId: trimmed };
	return { provider: trimmed.slice(0, slash), modelId: trimmed.slice(slash + 1) };
}

const RUNTIME_RATE_LIMIT_PATTERNS = [
	/rate\s*limit/i,
	/usage\s*limit/i,
	/too many requests/i,
	/\b429\b/,
	/quota/i,
];

function accountProviderFamily(provider: string | undefined): string | undefined {
	if (!provider) return undefined;
	if (/^anthropic(?:-\d+|-account-\d+)?$/i.test(provider)) return "anthropic";
	if (/^openai-codex(?:-\d+|-account-\d+)?$/i.test(provider)) return "openai-codex";
	const legacy = /^(.*)-account-\d+$/i.exec(provider);
	return legacy?.[1]?.toLowerCase() ?? provider.toLowerCase();
}

/** Only account aliases for the exact same model are eligible for post-tool continuation. */
export function isSameModelAccountFallback(currentModel: string | undefined, nextModel: string | undefined): boolean {
	if (!currentModel || !nextModel) return false;
	const current = parseModelKey(currentModel);
	const next = parseModelKey(nextModel);
	if (!current.provider || !next.provider || current.modelId !== next.modelId) return false;
	const currentFamily = accountProviderFamily(current.provider);
	return currentFamily === accountProviderFamily(next.provider) && current.provider.toLowerCase() !== next.provider.toLowerCase();
}

/** Resolve configured fallback models, retaining only exact-model aliases from the
 * same supported account family. Cross-provider/model entries never become live
 * same-session continuation targets. Unknown candidates are skipped. */
export function resolveSameModelAccountFallbacks(
	currentModel: string | undefined,
	fallbackModels: readonly string[] | undefined,
	availableModels: AvailableModelInfo[] | undefined,
	preferredProvider?: string,
): string[] {
	if (!currentModel || !fallbackModels?.length || !availableModels?.length) return [];
	const resolved: string[] = [];
	for (const fallback of fallbackModels) {
		const candidate = resolveSubagentModelCandidate(fallback, availableModels, preferredProvider);
		if (!candidate || !isSameModelAccountFallback(currentModel, candidate)) continue;
		if (!resolved.includes(candidate)) resolved.push(candidate);
	}
	return resolved;
}

function completedToolHistory(messages: readonly unknown[]): { completed: number; safe: boolean } {
	const pending = new Set<string>();
	let completed = 0;
	for (const raw of messages) {
		if (!raw || typeof raw !== "object") continue;
		const message = raw as { role?: unknown; content?: unknown; toolCallId?: unknown; isError?: unknown };
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const part of message.content) {
				if (!part || typeof part !== "object" || (part as { type?: unknown }).type !== "toolCall") continue;
				const id = (part as { id?: unknown }).id;
				if (typeof id !== "string" || !id) return { completed, safe: false };
				pending.add(id);
			}
		}
		if (message.role !== "toolResult") continue;
		if (message.isError === true || typeof message.toolCallId !== "string" || !pending.delete(message.toolCallId)) {
			return { completed, safe: false };
		}
		completed++;
	}
	return { completed, safe: pending.size === 0 };
}

/**
 * Fail closed unless a trusted terminal assistant rate/quota error follows a
 * fully paired, error-free tool history. Tool text merely mentioning 429 can
 * never satisfy this predicate.
 */
export function canContinueSameSessionAfterRateLimit(input: {
	currentModel?: string;
	nextModel?: string;
	error?: string;
	messages?: readonly unknown[];
	toolCount?: number;
	currentTool?: string;
	cancelled?: boolean;
	budgetExhausted?: boolean;
	structuredOutputInvoked?: boolean;
}): boolean {
	if (!isSameModelAccountFallback(input.currentModel, input.nextModel)) return false;
	if (input.cancelled || input.budgetExhausted || input.structuredOutputInvoked || input.currentTool) return false;
	if ((input.toolCount ?? 0) <= 0 || !input.error || !RUNTIME_RATE_LIMIT_PATTERNS.some((pattern) => pattern.test(input.error!))) return false;
	const messages = input.messages ?? [];
	const terminal = messages.at(-1) as { role?: unknown; stopReason?: unknown; errorMessage?: unknown } | undefined;
	if (terminal?.role !== "assistant" || terminal.stopReason !== "error") return false;
	if (typeof terminal.errorMessage !== "string" || terminal.errorMessage.trim() !== input.error.trim()) return false;
	const history = completedToolHistory(messages);
	return history.safe && history.completed > 0;
}
/** Context-overflow signals used to surface a clear input-too-large error. */
const CONTEXT_OVERFLOW_PATTERNS = [
	/context(?: length| window| limit)? (?:exceed|overflow|too long)/i,
	/maximum context length/i,
	/too many tokens/i,
	/token limit/i,
	/context_length_exceeded/i,
	/length_required/i,
	/maximum.*tokens/i,
	/prompt.*too long/i,
	/input.*too long/i,
	/exceeded.*context/i,
	/context.*overflow/i,
];

export function isContextOverflow(error: string | undefined): boolean {
	if (!error) return false;
	if (/^[\w.:@/-]+ failed (?:(?:\(exit \d+\):)|(?:with exit code \d+))(?:\s|$)/i.test(error.trim())) return false;
	return CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(error));
}
