import { extname } from "node:path";
import { ValidationError } from "./errors.js";
import type { InputFile, InputFileDescriptor, ProcessedInput } from "./types.js";

export interface InputProcessorArgs {
	prompt?: string | undefined;
	files?: InputFile[] | undefined;
}

const SUPPORTED_EXTENSIONS = new Set([".md", ".txt"]);
const SEPARATOR = "\n\n---\n\n";

export function processInput(args: InputProcessorArgs): ProcessedInput {
	validate(args);

	const trimmed = args.prompt?.trim();
	const prompt = trimmed && trimmed.length > 0 ? trimmed : null;
	const { descriptors, contents } = normalizeFiles(args.files ?? []);
	const context = buildContext(prompt, contents);

	return { context, prompt, inputFiles: descriptors };
}

function validate(args: InputProcessorArgs): void {
	const hasPrompt = args.prompt !== undefined;
	const hasFiles = args.files !== undefined && args.files.length > 0;

	if (!hasPrompt && !hasFiles) {
		throw new ValidationError("At least one of prompt or files must be provided");
	}
	if (hasPrompt && args.prompt!.trim().length === 0) {
		throw new ValidationError("Prompt cannot be empty when provided");
	}
	for (const file of args.files ?? []) {
		const ext = extname(file.name).toLowerCase();
		if (!SUPPORTED_EXTENSIONS.has(ext)) {
			throw new ValidationError(`Unsupported file type: ${ext}. Only .md and .txt are accepted.`);
		}
		if (file.content.length === 0) {
			throw new ValidationError(`File ${file.name} is empty.`);
		}
	}
}

function normalizeFiles(files: InputFile[]): {
	descriptors: InputFileDescriptor[];
	contents: string[];
} {
	const descriptors: InputFileDescriptor[] = [];
	const contents: string[] = [];
	files.forEach((file, index) => {
		const ext = extname(file.name).toLowerCase();
		const paddedIndex = String(index + 1).padStart(3, "0");
		descriptors.push({
			originalName: file.name,
			normalizedName: `doc-${paddedIndex}${ext}`,
			sizeBytes: Buffer.byteLength(file.content, "utf-8"),
		});
		contents.push(file.content);
	});
	return { descriptors, contents };
}

function buildContext(prompt: string | null, fileContents: string[]): string {
	const parts: string[] = [];
	if (prompt) parts.push(prompt);
	for (const content of fileContents) parts.push(content);
	return parts.join(SEPARATOR);
}
