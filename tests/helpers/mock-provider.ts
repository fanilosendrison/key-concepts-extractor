import type { LLMRequest, LLMResponse, ProviderAdapter } from "../../src/domain/ports.js";
import type { ProviderLongId } from "../../src/domain/types.js";

export interface MockCallRecord {
  request: LLMRequest;
  respondedAt: number;
}

export interface MockProviderAdapter extends ProviderAdapter {
  readonly calls: MockCallRecord[];
  readonly remaining: number;
}

/**
 * FIFO queue of response strings. Each call() pops one.
 * Throws if the queue is empty (catches tests that trigger more calls than expected).
 */
export function createMockProvider(
  provider: ProviderLongId,
  responses: string[] = [],
): MockProviderAdapter {
  const queue = [...responses];
  const calls: MockCallRecord[] = [];

  return {
    provider,
    get calls() {
      return [...calls];
    },
    get remaining() {
      return queue.length;
    },
    async call(request: LLMRequest): Promise<LLMResponse> {
      const content = queue.shift();
      if (content === undefined) {
        throw new Error(
          `MockProvider[${provider}] received unexpected call (queue empty). Prompt: ${request.systemPrompt.slice(0, 60)}...`,
        );
      }
      calls.push({ request, respondedAt: Date.now() });
      return {
        content,
        provider,
        model: `mock-${provider}`,
        latencyMs: 1,
      };
    },
  };
}
