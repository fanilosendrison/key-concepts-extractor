export class ValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ValidationError";
	}
}

export class FatalLLMError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "FatalLLMError";
	}
}

export class TransientLLMError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TransientLLMError";
	}
}

// Normalise an unknown thrown value into a human string for logs / error payloads.
// JS catch clauses yield `unknown`; this canonicalises the "Error → message,
// other → toString" pattern that showed up in 4+ places.
export function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
