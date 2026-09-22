import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const SOURCE_SLICE_BINDING = "pi-subagents.source-slice/1";
export function sourceSlicePaths(bindings: Record<string, unknown> | undefined): string[] | undefined {
	const value = bindings?.[SOURCE_SLICE_BINDING];
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid source slice binding.");
	const record = value as Record<string, unknown>;
	if (Object.keys(record).length !== 1 || !Array.isArray(record.paths) || record.paths.length > 8 || record.paths.some((file) => typeof file !== "string" || !path.isAbsolute(file) || path.normalize(file) !== file)) throw new Error("Invalid source slice mutation paths.");
	return [...record.paths] as string[];
}

/** Tool-call enforcement only. Trusted runtime code and filesystem races are outside this boundary. */
export function sourceSliceToolDenial(paths: string[], cwd: string, tool: string, input: Record<string, unknown>): string | undefined {
	if (["read", "grep", "find", "ls", "structured_output", "contact_supervisor"].includes(tool)) return undefined;
	if (tool !== "write" && tool !== "edit") return "Source-only slice forbids execution and non-allowlisted tools (including diagnostic compilation).";
	if (typeof input.path !== "string") return "Source slice mutation requires an exact path.";
	const file = path.resolve(cwd, input.path.replace(/^@/, ""));
	if (!paths.includes(file)) return "Mutation path is outside this slice's exact inventory.";
	try {
		// Check each existing component, including for a not-yet-created file.
		let current = path.parse(file).root;
		for (const component of file.slice(current.length).split(path.sep)) {
			current = path.join(current, component);
			try {
				const stat = fs.lstatSync(current);
				if (stat.isSymbolicLink() || (current === file && (!stat.isFile() || stat.nlink !== 1))) return "Source slice mutation refuses links and non-regular files.";
			} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		}
	} catch { return "Cannot verify source slice mutation path."; }
	return undefined;
}
export function registerSourceSlicePolicy(pi: ExtensionAPI, paths: string[]): void {
	pi.on("tool_call", (event, ctx) => {
		const reason = sourceSliceToolDenial(paths, ctx.cwd, event.toolName, event.input as Record<string, unknown>);
		return reason ? { block: true, reason } : undefined;
	});
}
