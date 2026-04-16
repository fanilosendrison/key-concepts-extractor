import { describe, expect, it } from "vitest";
import { DEFAULT_RUN_CONFIG } from "../src/domain/types.js";
import { loadStartupConfig } from "../src/infra/config-loader.js";

const validEnv: NodeJS.ProcessEnv = {
	ANTHROPIC_API_KEY: "sk-ant-test",
	OPENAI_API_KEY: "sk-openai-test",
	GOOGLE_API_KEY: "sk-google-test",
	HOME: "/tmp/fake-home",
};

describe("loadStartupConfig (NIB-S-KCE §P6)", () => {
	it("T-CFG-01: resolves all three API keys from env", () => {
		const cfg = loadStartupConfig(validEnv);
		expect(cfg.secrets).toEqual({
			anthropicApiKey: "sk-ant-test",
			openaiApiKey: "sk-openai-test",
			googleApiKey: "sk-google-test",
		});
	});

	it("T-CFG-02: returns DEFAULT_RUN_CONFIG when no overrides set", () => {
		const cfg = loadStartupConfig(validEnv);
		expect(cfg.runConfig).toEqual(DEFAULT_RUN_CONFIG);
	});

	it("T-CFG-03: baseDir defaults to ~/.kce", () => {
		const cfg = loadStartupConfig(validEnv);
		expect(cfg.baseDir).toBe("/tmp/fake-home/.kce");
	});

	it("T-CFG-04: throws when ANTHROPIC_API_KEY missing", () => {
		const { ANTHROPIC_API_KEY: _, ...rest } = validEnv;
		expect(() => loadStartupConfig(rest)).toThrow(/ANTHROPIC_API_KEY/);
	});

	it("T-CFG-05: throws when OPENAI_API_KEY missing", () => {
		const { OPENAI_API_KEY: _, ...rest } = validEnv;
		expect(() => loadStartupConfig(rest)).toThrow(/OPENAI_API_KEY/);
	});

	it("T-CFG-06: throws when GOOGLE_API_KEY missing", () => {
		const { GOOGLE_API_KEY: _, ...rest } = validEnv;
		expect(() => loadStartupConfig(rest)).toThrow(/GOOGLE_API_KEY/);
	});
});
