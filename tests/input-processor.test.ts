import { describe, expect, it } from "vitest";
import { ValidationError } from "../src/domain/errors.js";
import { processInput } from "../src/domain/input-processor.js";

describe("InputProcessor", () => {
	it("T-IP-01: prompt only", () => {
		const result = processInput({ prompt: "Variance inter-run" });
		expect(result).toEqual({
			context: "Variance inter-run",
			prompt: "Variance inter-run",
			inputFiles: [],
		});
	});

	it("T-IP-02: files only", () => {
		const result = processInput({
			files: [
				{ name: "a.md", content: "AAA" },
				{ name: "b.txt", content: "BBB" },
			],
		});
		expect(result.context).toBe("AAA\n\n---\n\nBBB");
		expect(result.prompt).toBeNull();
		expect(result.inputFiles).toEqual([
			{ originalName: "a.md", normalizedName: "doc-001.md", sizeBytes: 3 },
			{ originalName: "b.txt", normalizedName: "doc-002.txt", sizeBytes: 3 },
		]);
	});

	it("T-IP-03: both prompt and files", () => {
		const result = processInput({
			prompt: "Focus",
			files: [{ name: "c.md", content: "CCC" }],
		});
		expect(result.context.startsWith("Focus")).toBe(true);
		expect(result.context.includes("---")).toBe(true);
		expect(result.context.endsWith("CCC")).toBe(true);
	});

	it("T-IP-04: validation — no input", () => {
		expect(() => processInput({})).toThrow(ValidationError);
	});

	it("T-IP-05: validation — empty prompt", () => {
		expect(() => processInput({ prompt: "" })).toThrow(ValidationError);
	});

	it("T-IP-06: validation — unsupported file type", () => {
		expect(() => processInput({ files: [{ name: "doc.pdf", content: "x" }] })).toThrow(/\.pdf/);
	});

	it("T-IP-07: validation — empty file", () => {
		expect(() => processInput({ files: [{ name: "empty.md", content: "" }] })).toThrow(
			ValidationError,
		);
	});

	it("T-IP-08: whitespace-only prompt", () => {
		expect(() => processInput({ prompt: "   " })).toThrow(ValidationError);
	});
});
