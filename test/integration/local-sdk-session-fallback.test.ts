import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import { Type } from "typebox";
import { runSync } from "../../src/runs/foreground/execution.ts";
import {
	createDefaultChildSessionFactory,
	type ChildSessionFactory,
	type PiCodingAgentModule,
} from "../../src/runs/shared/child-session.ts";
import { SAME_SESSION_ACCOUNT_FALLBACK_NOTICE } from "../../src/runs/shared/model-fallback.ts";
import { clearExclusions, flushPersist as flushModelExclusions } from "../../src/runs/shared/model-exclusions.ts";
import { makeAgent } from "../support/helpers.ts";

const configuredSdkPath = process.env.PI_SUBAGENTS_LOCAL_SDK_PATH?.trim();
const sdkPath = configuredSdkPath ? path.resolve(configuredSdkPath) : undefined;
const localSdkAvailable = Boolean(sdkPath && fs.existsSync(sdkPath));

type RecordedMessage = {
	role?: string;
	content?: unknown;
	toolCallId?: string;
};

type RecordedRequest = {
	provider: string;
	messages: RecordedMessage[];
};

describe("local Pi SDK same-session account fallback", { skip: !localSdkAvailable ? "set PI_SUBAGENTS_LOCAL_SDK_PATH to a built coding-agent dist/index.js" : undefined }, () => {
	it("retains completed tool history and executes a non-idempotent tool exactly once", async () => {
		const resolvedSdkPath = sdkPath!;
		const aiPath = path.resolve(path.dirname(resolvedSdkPath), "../../ai/dist/index.js");
		assert.equal(fs.existsSync(aiPath), true, `Pi AI dist entry not found beside configured SDK: ${aiPath}`);
		const pi = await import(pathToFileURL(resolvedSdkPath).href) as PiCodingAgentModule;
		const ai = await import(pathToFileURL(aiPath).href) as {
			createAssistantMessageEventStream: () => { push: (event: unknown) => void };
		};
		const tempDir = fs.mkdtempSync(path.join(process.env.PI_SUBAGENTS_TEMP_ROOT ?? process.cwd(), "local-sdk-fallback-"));
		const agentDir = path.join(tempDir, "agent");
		const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
		const priorExclusionsPath = process.env.PI_MODEL_EXCLUSIONS_PATH;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		process.env.PI_MODEL_EXCLUSIONS_PATH = path.join(tempDir, "model-exclusions.json");
		fs.mkdirSync(agentDir, { recursive: true });

		let toolExecutions = 0;
		const requests: RecordedRequest[] = [];
		const usage = {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const assistant = (provider: string, content: unknown[], stopReason: string, errorMessage?: string) => ({
			role: "assistant",
			content,
			api: "openai-completions",
			provider,
			model: "same-model",
			usage,
			stopReason,
			...(errorMessage ? { errorMessage } : {}),
			timestamp: Date.now(),
		});
		const streamResponse = (event: unknown) => {
			const stream = ai.createAssistantMessageEventStream();
			queueMicrotask(() => stream.push(event));
			return stream;
		};
		const providerConfig = (provider: string) => ({
			name: provider,
			baseUrl: "https://local.invalid",
			apiKey: "local-test-key",
			api: "openai-completions",
			models: [{
				id: "same-model",
				name: "Same Model",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 16_000,
				maxTokens: 1_000,
			}],
			streamSimple: (_model: unknown, context: { messages: RecordedMessage[] }) => {
				requests.push({ provider, messages: JSON.parse(JSON.stringify(context.messages)) as RecordedMessage[] });
				if (provider === "quota-account-1" && !context.messages.some((message) => message.role === "toolResult")) {
					const message = assistant(provider, [{ type: "toolCall", id: "counter-call-1", name: "non_idempotent_counter", arguments: {} }], "toolUse");
					return streamResponse({ type: "done", reason: "toolUse", message });
				}
				if (provider === "quota-account-1") {
					const error = assistant(provider, [], "error", "429 runtime quota exhausted");
					return streamResponse({ type: "error", reason: "error", error });
				}
				const message = assistant(provider, [{ type: "text", text: "continued from retained result" }], "stop");
				return streamResponse({ type: "done", reason: "stop", message });
			},
		});

		const sdkFactory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => pi });
		const factory: ChildSessionFactory = {
			create: (launch) => sdkFactory.create({
				...launch,
				hooks: [...launch.hooks, {
					name: "local-sdk-fake-transport",
					factory: ((extension: {
						registerProvider: (name: string, config: unknown) => void;
						registerTool: (tool: unknown) => void;
					}) => {
						extension.registerProvider("quota-account-1", providerConfig("quota-account-1"));
						extension.registerProvider("quota-account-2", providerConfig("quota-account-2"));
						extension.registerTool({
							name: "non_idempotent_counter",
							label: "Non-idempotent counter",
							description: "Increment the test counter exactly once.",
							parameters: Type.Object({}),
							execute: async () => {
								toolExecutions++;
								return { content: [{ type: "text", text: `execution ${toolExecutions}` }], details: {} };
							},
						});
					}) as never,
				}],
			}),
			dispose: () => sdkFactory.dispose(),
		};

		try {
			const result = await runSync(
				tempDir,
				[makeAgent("echo", {
					model: "quota-account-1/same-model",
					fallbackModels: ["quota-account-2/same-model"],
					tools: ["non_idempotent_counter"],
					completionGuard: false,
				})],
				"echo",
				"Increment the counter once, then report success",
				{
					runId: "local-sdk-same-session-fallback",
					childSessionFactory: factory,
					availableModels: [
						{ provider: "quota-account-1", id: "same-model", fullId: "quota-account-1/same-model" },
						{ provider: "quota-account-2", id: "same-model", fullId: "quota-account-2/same-model" },
					],
				},
			);

			assert.equal(result.exitCode, 0, result.error);
			assert.equal(toolExecutions, 1, "the SDK tool must not be replayed after the account switch");
			assert.equal(result.progressSummary?.toolCount, 1, "host tool counters must remain cumulative");
			assert.deepEqual(result.attemptedModels, ["quota-account-1/same-model", "quota-account-2/same-model"]);
			const continuation = requests.find((request) => request.provider === "quota-account-2");
			assert.ok(continuation, "the alias provider must receive a continuation request");
			assert.equal(continuation.messages.some((message) => message.role === "assistant" && Array.isArray(message.content) && message.content.some((part) => (part as { type?: string; id?: string }).type === "toolCall" && (part as { id?: string }).id === "counter-call-1")), true, "continuation request must retain the prior tool call");
			assert.equal(continuation.messages.some((message) => message.role === "toolResult" && message.toolCallId === "counter-call-1"), true, "continuation request must retain the paired tool result");
			const userTexts = continuation.messages
				.filter((message) => message.role === "user")
				.map((message) => typeof message.content === "string"
					? message.content
					: Array.isArray(message.content)
						? message.content.map((part) => (part as { type?: string; text?: string }).type === "text" ? (part as { text?: string }).text ?? "" : "").join("")
						: "");
			assert.equal(userTexts.filter((text) => text.startsWith("Task: Increment the counter once")).length, 1, "the original task must not be replayed");
			assert.equal(userTexts.at(-1), SAME_SESSION_ACCOUNT_FALLBACK_NOTICE);
		} finally {
			await factory.dispose();
			clearExclusions();
			flushModelExclusions();
			if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
			if (priorExclusionsPath === undefined) delete process.env.PI_MODEL_EXCLUSIONS_PATH;
			else process.env.PI_MODEL_EXCLUSIONS_PATH = priorExclusionsPath;
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
