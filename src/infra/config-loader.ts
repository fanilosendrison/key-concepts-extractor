import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_RUN_CONFIG, type RunConfig } from "../domain/types.js";

export interface ResolvedSecrets {
	anthropicApiKey: string;
	openaiApiKey: string;
	googleApiKey: string;
}

export interface ResolvedStartupConfig {
	runConfig: RunConfig;
	secrets: ResolvedSecrets;
	baseDir: string;
}

function requireEnv(env: NodeJS.ProcessEnv, key: string): string {
	const v = env[key];
	if (!v || v.length === 0) {
		throw new Error(`Missing required environment variable: ${key}`);
	}
	return v;
}

export function loadStartupConfig(env: NodeJS.ProcessEnv): ResolvedStartupConfig {
	const secrets: ResolvedSecrets = {
		anthropicApiKey: requireEnv(env, "ANTHROPIC_API_KEY"),
		openaiApiKey: requireEnv(env, "OPENAI_API_KEY"),
		googleApiKey: requireEnv(env, "GOOGLE_API_KEY"),
	};
	const home = env.HOME ?? homedir();
	return {
		runConfig: { ...DEFAULT_RUN_CONFIG, models: { ...DEFAULT_RUN_CONFIG.models } },
		secrets,
		baseDir: join(home, ".kce"),
	};
}
