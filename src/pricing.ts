import { TokenUsage } from './llm';

/**
 * Prices in USD per MILLION tokens. Cache reads are billed at ~0.1× the
 * base input rate; cache writes (ephemeral) at ~1.25×. Source: Anthropic's
 * public pricing page as of the current model cutoff — if this drifts,
 * users can open Settings and the raw numbers live here.
 */
interface ModelPrice {
  inputPerM: number;
  outputPerM: number;
}

const PRICING: Record<string, ModelPrice> = {
  'claude-opus-4-6':   { inputPerM: 5.0,  outputPerM: 25.0 },
  'claude-sonnet-4-6': { inputPerM: 3.0,  outputPerM: 15.0 },
  'claude-haiku-4-5':  { inputPerM: 1.0,  outputPerM: 5.0 },
  // Legacy / aliases — fall back gracefully.
  'claude-opus-4-5':   { inputPerM: 5.0,  outputPerM: 25.0 },
  'claude-sonnet-4-5': { inputPerM: 3.0,  outputPerM: 15.0 },
};

const CACHE_READ_MULT = 0.1;
const CACHE_WRITE_MULT = 1.25;

/**
 * Returns the estimated USD cost of a generation given its model and
 * the `usage` block the Anthropic SDK returned. Unknown models return
 * null — we'd rather admit we don't know than silently show $0.
 */
export function estimateCostUsd(
  model: string,
  usage: TokenUsage,
): number | null {
  const price = PRICING[model];
  if (!price) return null;

  // `input_tokens` in Anthropic's SDK is the *uncached* portion. Cached
  // reads and writes are billed separately, so we need to add them back
  // at the discounted / premium rate.
  const uncachedIn = usage.input_tokens || 0;
  const cachedRead = usage.cache_read_input_tokens || 0;
  const cachedWrite = usage.cache_creation_input_tokens || 0;
  const out = usage.output_tokens || 0;

  const inputCost =
    (uncachedIn * price.inputPerM +
      cachedRead * price.inputPerM * CACHE_READ_MULT +
      cachedWrite * price.inputPerM * CACHE_WRITE_MULT) /
    1_000_000;
  const outputCost = (out * price.outputPerM) / 1_000_000;
  return inputCost + outputCost;
}

/** Format a cost in USD for the Inspector hint — "$0.0123". */
export function formatCost(usd: number | null): string {
  if (usd === null) return '—';
  if (usd < 0.0001) return '< $0.0001';
  return `$${usd.toFixed(4)}`;
}
