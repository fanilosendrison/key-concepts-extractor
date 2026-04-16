import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dispatch } from "../src/cli/dispatch.js";
import { DEFAULT_RUN_CONFIG } from "../src/domain/types.js";
import type { ResolvedStartupConfig } from "../src/infra/config-loader.js";
import { cleanupTempDir, createTempDir } from "./helpers/temp-dir.js";

describe("dispatch (NIB-M-CLI)", () => {
	let baseDir: string;
	let startup: ResolvedStartupConfig;

	beforeEach(async () => {
		baseDir = await createTempDir();
		startup = {
			runConfig: DEFAULT_RUN_CONFIG,
			secrets: {
				anthropicApiKey: "sk-a",
				openaiApiKey: "sk-o",
				googleApiKey: "sk-g",
			},
			baseDir,
		};
	});

	afterEach(async () => {
		await cleanupTempDir(baseDir);
	});

	it("T-DSP-01: help command returns the parsed exitCode", async () => {
		const code = await dispatch({ command: "help", exitCode: 1, usage: "usage: kce ..." }, startup);
		expect(code).toBe(1);
	});

	it("T-DSP-02: unknown run_id on show returns 1", async () => {
		const code = await dispatch({ command: "show", options: { runId: "nonexistent" } }, startup);
		expect(code).toBe(1);
	});

	it("T-DSP-03: run with neither prompt nor files returns 1", async () => {
		const code = await dispatch({ command: "run", options: {} }, startup);
		expect(code).toBe(1);
	});
});
