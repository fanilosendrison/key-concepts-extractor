import type { z } from "zod";
import { fillTemplate } from "./collection-utils.js";
import type { EventPayloads } from "./event-schemas.js";
import type { ProviderAdapter } from "./ports.js";
import type { ControllableConcept, ControlScope, PipelineEventType } from "./types.js";

export type ControlKind = "quality" | "relevance";
export type EmitFn = (type: PipelineEventType, payload: Record<string, unknown>) => void;

// NIB-M-QUALITY-CONTROLLER §6 + NIB-M-RELEVANCE-CONTROLLER §6 :
// fail-closed at every R1/R2/R3 trust boundary.
export class ControlSchemaError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ControlSchemaError";
	}
}

interface CallRoundParams<O> {
	control: ControlKind;
	adapter: ProviderAdapter;
	provider: "anthropic" | "openai";
	systemPrompt: string;
	userPromptTemplate: string;
	templateVars: Record<string, string>;
	round: 1 | 2 | 3;
	model: "claude" | "gpt";
	scope: ControlScope;
	emit: EmitFn;
	schema: z.ZodType<O>;
	signal?: AbortSignal | undefined;
}

export async function callLLMRound<O>(p: CallRoundParams<O>): Promise<O> {
	p.emit("control_start", {
		control: p.control,
		round: p.round,
		model: p.model,
		scope: p.scope,
	} satisfies EventPayloads["control_start"]);
	const response = await p.adapter.call({
		systemPrompt: p.systemPrompt,
		userPrompt: fillTemplate(p.userPromptTemplate, p.templateVars),
		provider: p.provider,
		signal: p.signal,
	});
	let raw: unknown;
	try {
		raw = JSON.parse(response.content);
	} catch (e) {
		throw new ControlSchemaError(
			`${labelControl(p.control)} R${p.round} (${p.model}): invalid JSON response: ${(e as Error).message}`,
		);
	}
	const parsed = p.schema.safeParse(raw);
	if (!parsed.success) {
		throw new ControlSchemaError(
			`${labelControl(p.control)} R${p.round} (${p.model}): schema validation failed: ${parsed.error.message}`,
		);
	}
	return parsed.data;
}

function labelControl(c: ControlKind): "Quality" | "Relevance" {
	return c === "quality" ? "Quality" : "Relevance";
}

export interface ControlPrompts {
	r1: { system: string; user: string };
	r2: { system: string; user: string };
	r3: { system: string; user: string };
}

export interface ControlSchemas<R1, R2, R3> {
	r1: z.ZodType<R1>;
	r2: z.ZodType<R2>;
	r3: z.ZodType<R3>;
}

export interface ThreeRoundInput<T extends ControllableConcept, R1, R2, R3, Output> {
	control: ControlKind;
	mergedList: T[];
	context: string;
	scope: ControlScope;
	anthropic: ProviderAdapter;
	openai: ProviderAdapter;
	emit?: EmitFn | undefined;
	signal?: AbortSignal | undefined;
	prompts: ControlPrompts;
	schemas: ControlSchemas<R1, R2, R3>;
	// Returns non-null when R1 alone resolves the run (no findings) → skip R2/R3.
	earlyExit: (r1: R1, mergedList: T[]) => Output | null;
	// Returns true when R2 outputs require R3 arbitration.
	shouldFireR3: (r2: R2) => boolean;
	// Final aggregation. r3 is null when shouldFireR3 returned false.
	aggregate: (args: {
		r1: R1;
		r2: R2;
		r3: R3 | null;
		mergedList: T[];
		roundsUsed: number;
	}) => Output;
}

export async function runThreeRoundControl<T extends ControllableConcept, R1, R2, R3, Output>(
	input: ThreeRoundInput<T, R1, R2, R3, Output>,
): Promise<Output> {
	const mergedListJson = JSON.stringify(input.mergedList);
	const emit = input.emit ?? (() => {});

	input.signal?.throwIfAborted();
	const r1 = await callLLMRound<R1>({
		control: input.control,
		adapter: input.anthropic,
		provider: "anthropic",
		systemPrompt: input.prompts.r1.system,
		userPromptTemplate: input.prompts.r1.user,
		templateVars: { context: input.context, merged_list: mergedListJson },
		round: 1,
		model: "claude",
		scope: input.scope,
		emit,
		schema: input.schemas.r1,
		signal: input.signal,
	});

	const exitOutput = input.earlyExit(r1, input.mergedList);
	if (exitOutput !== null) return exitOutput;

	input.signal?.throwIfAborted();
	const r2 = await callLLMRound<R2>({
		control: input.control,
		adapter: input.openai,
		provider: "openai",
		systemPrompt: input.prompts.r2.system,
		userPromptTemplate: input.prompts.r2.user,
		templateVars: {
			context: input.context,
			merged_list: mergedListJson,
			claude_findings: JSON.stringify(r1),
		},
		round: 2,
		model: "gpt",
		scope: input.scope,
		emit,
		schema: input.schemas.r2,
		signal: input.signal,
	});

	let r3: R3 | null = null;
	if (input.shouldFireR3(r2)) {
		input.signal?.throwIfAborted();
		r3 = await callLLMRound<R3>({
			control: input.control,
			adapter: input.anthropic,
			provider: "anthropic",
			systemPrompt: input.prompts.r3.system,
			userPromptTemplate: input.prompts.r3.user,
			templateVars: {
				context: input.context,
				merged_list: mergedListJson,
				claude_findings: JSON.stringify(r1),
				gpt_findings: JSON.stringify(r2),
			},
			round: 3,
			model: "claude",
			scope: input.scope,
			emit,
			schema: input.schemas.r3,
			signal: input.signal,
		});
	}

	return input.aggregate({
		r1,
		r2,
		r3,
		mergedList: input.mergedList,
		roundsUsed: r3 ? 3 : 2,
	});
}
