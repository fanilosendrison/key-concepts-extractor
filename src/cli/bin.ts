#!/usr/bin/env -S node --experimental-strip-types
// NIB-M-CLI — `kce` executable entrypoint.
import { loadStartupConfig } from "../infra/config-loader.js";
import { dispatch } from "./dispatch.js";
import { parseCli } from "./index.js";

async function main(): Promise<void> {
	const parsed = parseCli(process.argv);
	const startup = loadStartupConfig(process.env);
	const code = await dispatch(parsed, startup);
	process.exit(code);
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : err);
	process.exit(1);
});
