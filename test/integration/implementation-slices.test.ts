import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { createEventBus, makeAgent, makeMinimalCtx } from "../support/helpers.ts";
import { installAsyncExecutionHooks, available, createSubagentExecutor, mockPi, tempDir, readAsyncPayload } from "../support/async-execution-fixture.ts";

describe("implementation slice launcher admission", { skip: !available }, () => {
	installAsyncExecutionHooks();
	for (const async of [false, true]) {
		it(`refuses alternate launchers without launching a child (async=${async})`, async () => {
			const file = path.join(tempDir, "source.ts");
			fs.writeFileSync(file, "// original\n");
			const executor = createSubagentExecutor!({
				pi: { events: createEventBus(), getSessionName: () => undefined, sendMessage() {} },
				state: { baseCwd: tempDir, currentSessionId: null, asyncJobs: new Map(), foregroundControls: new Map(), lastForegroundControlId: null },
				config: {}, asyncByDefault: false, tempArtifactsDir: tempDir,
				getSubagentSessionRoot: () => tempDir, expandTilde: (p: string) => p,
				discoverAgents: () => ({ agents: [makeAgent("worker", { launcher: "must-not-run" }), makeAgent("reviewer")] }),
			});
			const spec = {
				key: "guard", deliverable: "One helper", paths: [file], inputs: [], dependencies: [],
				criteria: "Export helper", validationScope: "source-only",
				writer: { agent: "worker", timeoutMs: 5000 }, reviewer: { agent: "reviewer", timeoutMs: 5000 },
				firstProgressMs: 1000, checkpointIntervalMs: 1000,
			};
			const result = await executor.executePublic(`slice-launcher-${async}`, {
				workflowScript: `return await runs.slice(${JSON.stringify(spec)});`, async, output: false,
			}, new AbortController().signal, undefined, makeMinimalCtx(tempDir));
			const evidence = async ? await readAsyncPayload(result.details.asyncId!) : result;
			assert.match(JSON.stringify(evidence), /Implementation slice agent 'worker'.*native Pi child with no alternate runner\/launcher/);
			assert.equal(fs.readFileSync(file, "utf8"), "// original\n");
			assert.equal(fs.readdirSync(mockPi.dir).filter((name) => /^call-.*\.json$/.test(name)).length, 0);
		});
	}
});
