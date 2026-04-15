import { TransientLLMError } from "./errors.js";
import type { LLMRequest, ProviderAdapter } from "./ports.js";
import {
	type AngleId,
	CANONICAL_ANGLES,
	type ProviderId,
	type ProviderLongId,
	type RawConcept,
} from "./types.js";

const PROVIDER_PAIRS: Array<{ long: ProviderLongId; short: ProviderId }> = [
	{ long: "anthropic", short: "claude" },
	{ long: "openai", short: "gpt" },
	{ long: "google", short: "gemini" },
];

// LLM Payloads v0.2 — Type 1 (Extraction)
const TYPE1_SYSTEM_PROMPT = `You are a key concept extractor for academic research.

Your mission: analyze the provided document from a specific angle and extract all key concepts relevant to a bibliographic search.

ANALYSIS ANGLE:
{angle_prompt}

CROSS-CUTTING CONSTRAINT:
Explore concepts at all levels of granularity, from the most technical (token, model) to the most conceptual (system, discipline).

RULES:
- Extract each concept as a short term (1 to 4 words maximum).
- For each concept, indicate its category, granularity level, and whether the exact term appears in the source document.
- Provide a one-sentence justification explaining why this concept is relevant to a bibliographic search.
- Do not filter. When in doubt about relevance, include the concept.
- Respond ONLY with valid JSON, no preamble, no markdown.

OUTPUT SCHEMA:
{
  "concepts": [
    {
      "term": "string — the extracted concept (1-4 words, in academic English)",
      "category": "string — one of: phenomenon | method | metric | property | architecture | tool | constraint | context",
      "granularity": "string — one of: token-level | model-level | system-level | pipeline-level | domain-level",
      "explicit_in_source": "boolean — true if the exact term appears in the document",
      "justification": "string — one sentence explaining why this concept is relevant"
    }
  ]
}`;

const TYPE1_USER_PROMPT = `SOURCE DOCUMENT:
{context}

Analyze this document according to the defined angle and extract all relevant key concepts.`;

const ANGLE_PROMPTS: Record<AngleId, string> = {
	extraction_directe:
		"What phenomena, methods, techniques, architectures, and metrics does this document explicitly mention? Extract each concept using the exact term found in the text. Do not infer anything — extract only what is named.",
	etats_ideaux:
		"What ideal properties is the described system trying to achieve? What pathological states is it trying to avoid? Extract the names of these properties and states, including the opposites and contraries of what is explicitly described. If the document describes a problem, name the targeted solution. If the document describes a solution, name the problem being fought.",
	mecanismes_causaux:
		"Analyze this document as a network of causes and effects. What concepts act as independent variables (levers that influence the result)? What concepts are intermediate mechanisms (mediators between cause and effect)? What concepts are confounding factors (sources of noise)? Extract the names of these variables, mediators, and factors, even if they are not named as such in the text.",
	taxonomie:
		"If this document were to be indexed in a scientific encyclopedia, under which categories, subcategories, and cross-cutting disciplines would it be classified? For each identifiable concept in this document, what canonical terms does the academic literature use to designate the same phenomenon? Extract both parent categories (disciplines, fields) and academic synonyms.",
	conditions_bord:
		"What operational constraints, starting assumptions, environmental conditions, and system limitations are described or implied in this document? What concepts related to deployment, scaling, compatibility, or usage context are present or implied?",
};

export interface ExtractionPass {
	angle: AngleId;
	provider: ProviderId;
	concepts: RawConcept[];
}

export interface ExtractionDeps {
	adapters: Record<ProviderLongId, ProviderAdapter>;
	onPass?: (pass: ExtractionPass) => Promise<void>;
	emit?: (type: string, payload: Record<string, unknown>) => void;
	signal?: AbortSignal | undefined;
}

export function buildExtractionRequest(
	context: string,
	angle: AngleId,
	provider: ProviderLongId,
	signal?: AbortSignal,
): LLMRequest {
	return {
		systemPrompt: TYPE1_SYSTEM_PROMPT.replace("{angle_prompt}", ANGLE_PROMPTS[angle]),
		userPrompt: TYPE1_USER_PROMPT.replace("{context}", context),
		provider,
		signal,
	};
}

function parseExtractionResponse(raw: string): RawConcept[] {
	const parsed = JSON.parse(raw) as unknown;
	const list: unknown = Array.isArray(parsed)
		? parsed
		: (parsed as { concepts?: unknown })?.concepts;
	if (!Array.isArray(list)) {
		throw new TransientLLMError(
			"Extraction response is neither an array nor has a concepts[] field",
		);
	}
	for (const item of list) {
		if (typeof item !== "object" || item === null) {
			throw new TransientLLMError("Invalid concept entry");
		}
		const c = item as Record<string, unknown>;
		if (typeof c.term !== "string" || typeof c.category !== "string") {
			throw new TransientLLMError("Concept missing required fields (term, category)");
		}
	}
	return list as RawConcept[];
}

export async function runExtraction(
	context: string,
	deps: ExtractionDeps,
): Promise<ExtractionPass[]> {
	const allPasses: ExtractionPass[] = [];

	for (const angle of CANONICAL_ANGLES) {
		if (deps.signal?.aborted) {
			const err = new Error("Pipeline aborted");
			(err as Error & { aborted?: boolean }).aborted = true;
			throw err;
		}
		deps.emit?.("extraction_progress", { completed: allPasses.length, total: 15 });

		const anglePasses = await Promise.all(
			PROVIDER_PAIRS.map(async ({ long, short }) => {
				deps.emit?.("extraction_start", { angle, model: short });
				const request = buildExtractionRequest(context, angle, long, deps.signal);
				const adapter = deps.adapters[long];
				const response = await adapter.call(request);
				const concepts = parseExtractionResponse(response.content);
				deps.emit?.("extraction_complete", {
					angle,
					model: short,
					concepts_count: concepts.length,
				});
				const pass: ExtractionPass = { angle, provider: short, concepts };
				if (deps.onPass) await deps.onPass(pass);
				return pass;
			}),
		);
		allPasses.push(...anglePasses);
	}

	deps.emit?.("extraction_progress", { completed: 15, total: 15 });
	return allPasses;
}
