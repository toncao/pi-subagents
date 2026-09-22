import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "../../shared/utils.ts";

/**
 * Live provider availability, as published by the optional `pi-multi-account`
 * companion extension.
 *
 * A cached model exclusion is a record of one past failure. For a limit-class
 * failure (429 / quota / usage limit) that record is a *forecast about a shared
 * account*, not a fact about the model: the account it describes is refilled by
 * the provider on its own schedule, and the companion already polls the
 * provider's real usage endpoint to find out when. Without this reader the
 * exclusion outlives the condition it describes and blocks a healthy account
 * for the remainder of its TTL.
 *
 * This module only ever *reads* the companion's published state. It never
 * writes it, and every failure mode degrades to {@link ProviderLiveness}
 * `"unknown"`, which leaves the caller's existing behaviour untouched. That
 * keeps pi-subagents fully functional when the companion is not installed.
 */

/** Written by pi-multi-account under the agent dir. */
const PROVIDER_FAILOVER_STATE_FILE = "provider-failover-state.json";

/**
 * A usage snapshot older than this is a stale reading, not evidence about now.
 * The companion refreshes on its own cadence (default 5 min); this is a
 * deliberately looser ceiling so a slow refresh reads as "unknown" rather than
 * as a false verdict in either direction.
 */
const MAX_SNAPSHOT_AGE_MS = 15 * 60_000;

/** `buildModelCandidates` can run many times per launch; don't re-read per call. */
const CACHE_TTL_MS = 5_000;

export type ProviderLiveness = "live" | "blocked" | "unknown";

interface UsageWindow {
	usedPercent?: unknown;
}

interface UsageSnapshot {
	fetchedAt?: unknown;
	serviceable?: unknown;
	primary?: UsageWindow;
}

interface FailoverState {
	usageByProvider?: Record<string, UsageSnapshot>;
	exhaustedUntilByProvider?: Record<string, unknown>;
	invalidatedByProvider?: Record<string, unknown>;
}

let cachedState: FailoverState | undefined;
let cacheInitialized = false;
let cachedAt = 0;
let cachedPath: string | undefined;

function statePath(): string {
	return path.join(getAgentDir(), PROVIDER_FAILOVER_STATE_FILE);
}

function readState(now: number): FailoverState | undefined {
	const file = statePath();
	if (cacheInitialized && cachedPath === file && now - cachedAt < CACHE_TTL_MS) return cachedState;
	let parsed: FailoverState | undefined;
	try {
		const raw = fs.readFileSync(file, "utf-8");
		const data = JSON.parse(raw) as unknown;
		if (data && typeof data === "object" && !Array.isArray(data)) parsed = data as FailoverState;
	} catch {
		// Absent (companion not installed), unreadable, or mid-write. All mean
		// "no opinion" — never an error, and never a reason to block a launch.
		parsed = undefined;
	}
	cachedState = parsed;
	cacheInitialized = true;
	cachedAt = now;
	cachedPath = file;
	return parsed;
}

/** Test seam: drop the memoized snapshot so the next call re-reads from disk. */
export function resetProviderLivenessCache(): void {
	cachedState = undefined;
	cacheInitialized = false;
	cachedAt = 0;
	cachedPath = undefined;
}

function recordedUntil(map: Record<string, unknown> | undefined, provider: string): number | undefined {
	const value = map?.[provider];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Resolve whether `provider` is serving right now.
 *
 * Precedence deliberately mirrors pi-multi-account's own `providerRecoveryAt`:
 * the account's own `serviceable` verdict outranks every derived number,
 * *including a cooldown the companion recorded itself*, because a percentage is
 * a forecast while `serviceable` is the account answering "can I be used right
 * now". Returns `"unknown"` whenever the published state does not clearly say.
 * When `evidenceAfter` is supplied, only a strictly newer usage snapshot may
 * report `"live"`; this prevents an older healthy reading from clearing a
 * failure recorded after that reading.
 */
export function getProviderLiveness(
	provider: string | undefined,
	now = Date.now(),
	evidenceAfter?: number,
): ProviderLiveness {
	if (!provider) return "unknown";
	const state = readState(now);
	if (!state) return "unknown";

	// A credential the companion has retired stays retired regardless of quota.
	const invalidatedUntil = recordedUntil(state.invalidatedByProvider, provider);
	if (invalidatedUntil !== undefined && invalidatedUntil > now) return "blocked";

	const snapshot = state.usageByProvider?.[provider];
	const fetchedAt = typeof snapshot?.fetchedAt === "number" ? snapshot.fetchedAt : undefined;
	const fresh =
		fetchedAt !== undefined &&
		now - fetchedAt >= 0 &&
		now - fetchedAt <= MAX_SNAPSHOT_AGE_MS &&
		(evidenceAfter === undefined || fetchedAt > evidenceAfter);

	if (fresh) {
		if (snapshot?.serviceable === true) return "live";
		if (snapshot?.serviceable === false) return "blocked";
	}

	const exhaustedUntil = recordedUntil(state.exhaustedUntilByProvider, provider);
	if (exhaustedUntil !== undefined && exhaustedUntil > now) return "blocked";

	if (fresh) {
		const usedPercent = snapshot?.primary?.usedPercent;
		if (typeof usedPercent === "number" && Number.isFinite(usedPercent)) {
			return usedPercent < 100 ? "live" : "blocked";
		}
	}
	return "unknown";
}
