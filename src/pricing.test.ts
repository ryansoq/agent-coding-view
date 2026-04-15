import { describe, it, expect } from 'vitest';
import { estimateCostUsd, formatCost } from './pricing';

describe('estimateCostUsd', () => {
  it('opus 4.6: 1000 in / 500 out = $0.0175', () => {
    const cost = estimateCostUsd('claude-opus-4-6', {
      input_tokens: 1000,
      output_tokens: 500,
    });
    // 1000 * $5/1M = $0.005, 500 * $25/1M = $0.0125, total $0.0175
    expect(cost).toBeCloseTo(0.0175, 6);
  });

  it('sonnet 4.6: 1M in / 1M out = $18', () => {
    const cost = estimateCostUsd('claude-sonnet-4-6', {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    });
    expect(cost).toBe(3 + 15);
  });

  it('haiku 4.5: 1M in / 1M out = $6', () => {
    const cost = estimateCostUsd('claude-haiku-4-5', {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    });
    expect(cost).toBe(1 + 5);
  });

  it('cache reads are discounted to 0.1x input', () => {
    const cost = estimateCostUsd('claude-opus-4-6', {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 1_000_000,
    });
    // 1M cached reads × $5/1M × 0.1 = $0.50
    expect(cost).toBeCloseTo(0.5, 6);
  });

  it('cache writes cost 1.25x input', () => {
    const cost = estimateCostUsd('claude-opus-4-6', {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 1_000_000,
    });
    // 1M cached writes × $5/1M × 1.25 = $6.25
    expect(cost).toBeCloseTo(6.25, 6);
  });

  it('returns null for unknown models', () => {
    expect(
      estimateCostUsd('claude-unknown-42', { input_tokens: 1, output_tokens: 1 }),
    ).toBeNull();
  });

  it('zero tokens = zero cost', () => {
    expect(
      estimateCostUsd('claude-opus-4-6', { input_tokens: 0, output_tokens: 0 }),
    ).toBe(0);
  });
});

describe('formatCost', () => {
  it('null → em dash', () => {
    expect(formatCost(null)).toBe('—');
  });
  it('tiny costs use "< $0.0001"', () => {
    expect(formatCost(0.00005)).toBe('< $0.0001');
  });
  it('normal costs show 4 decimal places', () => {
    expect(formatCost(0.0175)).toBe('$0.0175');
  });
  it('exact zero is zero, not tiny', () => {
    expect(formatCost(0)).toBe('< $0.0001');
  });
});
