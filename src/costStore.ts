import { create } from 'zustand';
import { TokenUsage } from './llm';
import { estimateCostUsd } from './pricing';

interface CostState {
  /** Sum of billable input tokens (uncached + cached*1.0 raw count) */
  totalInputTokens: number;
  totalOutputTokens: number;
  totalUsd: number;
  /** Number of successful generate calls recorded */
  callCount: number;

  record: (model: string, usage: TokenUsage) => void;
  reset: () => void;
}

/**
 * Session-local accumulator for LLM token usage and estimated USD cost.
 * Deliberately NOT persisted — the intent is "what did this session cost
 * me so far", and carrying it across tab reloads would be misleading.
 */
export const useCostStore = create<CostState>((set) => ({
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalUsd: 0,
  callCount: 0,

  record: (model, usage) =>
    set((state) => {
      const input =
        (usage.input_tokens || 0) +
        (usage.cache_read_input_tokens || 0) +
        (usage.cache_creation_input_tokens || 0);
      const output = usage.output_tokens || 0;
      const usd = estimateCostUsd(model, usage) ?? 0;
      return {
        totalInputTokens: state.totalInputTokens + input,
        totalOutputTokens: state.totalOutputTokens + output,
        totalUsd: state.totalUsd + usd,
        callCount: state.callCount + 1,
      };
    }),

  reset: () =>
    set({
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalUsd: 0,
      callCount: 0,
    }),
}));
