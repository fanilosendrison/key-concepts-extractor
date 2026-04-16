import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDriftCheck } from "../scripts/spec-drift.ts";
import { cleanupTempDir, createTempDir } from "./helpers/temp-dir.js";

async function setupFixture(
	root: string,
	spec: string,
	srcFiles: Record<string, string>,
): Promise<{ specsDir: string; srcDir: string }> {
	const specsDir = join(root, "specs");
	const srcDir = join(root, "src");
	await mkdir(specsDir, { recursive: true });
	await mkdir(srcDir, { recursive: true });
	await writeFile(join(specsDir, "NIB-TEST.md"), spec, "utf-8");
	for (const [name, content] of Object.entries(srcFiles)) {
		await writeFile(join(srcDir, name), content, "utf-8");
	}
	return { specsDir, srcDir };
}

describe("runDriftCheck", () => {
	let root: string;

	beforeEach(async () => {
		root = await createTempDir();
	});
	afterEach(async () => {
		await cleanupTempDir(root);
	});

	it("reports OK when spec and src declarations match", async () => {
		const spec = [
			"# Spec",
			"",
			"```typescript",
			"export interface Foo { a: number; b: string; }",
			"```",
		].join("\n");
		const { specsDir, srcDir } = await setupFixture(root, spec, {
			"foo.ts": "export interface Foo { a: number; b: string; }\n",
		});

		const { checked, missing } = runDriftCheck({
			specsDir,
			srcDir,
			tmpFile: join(root, "drift-assertion.ts"),
		});

		expect(checked).toHaveLength(1);
		expect(checked[0]?.name).toBe("Foo");
		expect(checked[0]?.status).toBe("OK");
		expect(missing).toHaveLength(0);
	});

	it("reports DRIFT when src declaration diverges from spec", async () => {
		const spec = [
			"# Spec",
			"",
			"```typescript",
			"export interface Bar { a: number; b: string; }",
			"```",
		].join("\n");
		const { specsDir, srcDir } = await setupFixture(root, spec, {
			"bar.ts": "export interface Bar { a: number; c: boolean; }\n",
		});

		const { checked, missing } = runDriftCheck({
			specsDir,
			srcDir,
			tmpFile: join(root, "drift-assertion.ts"),
		});

		expect(checked).toHaveLength(1);
		expect(checked[0]?.name).toBe("Bar");
		expect(checked[0]?.status).toBe("DRIFT");
		expect(checked[0]?.detail).toBeDefined();
		expect(missing).toHaveLength(0);
	});

	it("reports MISSING when spec declaration has no matching src export", async () => {
		const spec = [
			"# Spec",
			"",
			"```typescript",
			"export interface Ghost { x: number; }",
			"```",
		].join("\n");
		const { specsDir, srcDir } = await setupFixture(root, spec, {
			"placeholder.ts": "export interface Other { y: number; }\n",
		});

		const { checked, missing } = runDriftCheck({
			specsDir,
			srcDir,
			tmpFile: join(root, "drift-assertion.ts"),
		});

		expect(checked).toHaveLength(0);
		expect(missing).toHaveLength(1);
		expect(missing[0]?.name).toBe("Ghost");
	});
});
