import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadInputFiles } from "../src/infra/load-input-files.js";
import { cleanupTempDir, createTempDir } from "./helpers/temp-dir.js";

describe("loadInputFiles (NIB-M-CLI §3.2)", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await createTempDir();
	});

	afterEach(async () => {
		await cleanupTempDir(dir);
	});

	it("T-LIF-01: reads files into InputFile[] with basename + content", async () => {
		const a = join(dir, "a.md");
		const b = join(dir, "b.txt");
		writeFileSync(a, "alpha", "utf-8");
		writeFileSync(b, "beta", "utf-8");

		const result = await loadInputFiles([a, b]);

		expect(result).toEqual([
			{ name: "a.md", content: "alpha" },
			{ name: "b.txt", content: "beta" },
		]);
	});

	it("T-LIF-02: throws on missing path (NIB-M-CLI §4)", async () => {
		await expect(loadInputFiles([join(dir, "nope.md")])).rejects.toThrow(/not found|ENOENT/i);
	});

	it("T-LIF-03: empty list returns empty array", async () => {
		await expect(loadInputFiles([])).resolves.toEqual([]);
	});
});
