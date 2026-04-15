# Research Vision: Inter-run Output Consistency

The central question investigated here is the **variance** of LLM outputs across
repeated runs on identical prompts. When temperature is held at 0 and prompts
are held constant, we still observe semantic drift between runs — a phenomenon
we call *output inconsistency*.

## Goals

- Quantify the inter-run variance of outputs from three frontier models.
- Identify the mechanisms that produce drift: sampling stochasticity, hidden
  state, provider-side routing.
- Establish reliability benchmarks: a model is considered reliable when its
  outputs are semantically stable across at least 90% of repeated runs.

## Scope

We focus on extractive tasks (concept extraction from scientific texts), where
the *correct* answer is bounded by the source document. Out of scope: creative
generation, open-ended reasoning, blockchain-related applications.

## Hypotheses

1. Temperature is the dominant but not sole source of variance.
2. Output consistency correlates inversely with prompt ambiguity.
3. Aggregating multiple runs (consensus fusion) substantially reduces variance.
