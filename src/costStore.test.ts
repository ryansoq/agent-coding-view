import { beforeEach, describe, it, expect } from 'vitest';
import { useCostStore } from './costStore';

beforeEach(() => {
  useCostStore.getState().reset();
});

describe('useCostStore', () => {
  it('starts at zero', () => {
    const s = useCostStore.getState();
    expect(s.totalInputTokens).toBe(0);
    expect(s.totalOutputTokens).toBe(0);
    expect(s.totalUsd).toBe(0);
    expect(s.callCount).toBe(0);
  });

  it('records a single opus call', () => {
    useCostStore.getState().record('claude-opus-4-6', {
      input_tokens: 1000,
      output_tokens: 500,
    });
    const s = useCostStore.getState();
    expect(s.totalInputTokens).toBe(1000);
    expect(s.totalOutputTokens).toBe(500);
    expect(s.totalUsd).toBeCloseTo(0.0175, 6);
    expect(s.callCount).toBe(1);
  });

  it('accumulates across multiple calls', () => {
    useCostStore.getState().record('claude-opus-4-6', {
      input_tokens: 1000,
      output_tokens: 500,
    });
    useCostStore.getState().record('claude-sonnet-4-6', {
      input_tokens: 2000,
      output_tokens: 1000,
    });
    const s = useCostStore.getState();
    expect(s.totalInputTokens).toBe(3000);
    expect(s.totalOutputTokens).toBe(1500);
    // Opus: $0.0175, Sonnet: $0.006 + $0.015 = $0.021, total $0.0385
    expect(s.totalUsd).toBeCloseTo(0.0385, 6);
    expect(s.callCount).toBe(2);
  });

  it('counts cached input tokens too (separate from billing)', () => {
    useCostStore.getState().record('claude-opus-4-6', {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 900,
    });
    const s = useCostStore.getState();
    // Total input counts both uncached and cached reads
    expect(s.totalInputTokens).toBe(1000);
  });

  it('reset clears everything', () => {
    useCostStore.getState().record('claude-opus-4-6', {
      input_tokens: 1000,
      output_tokens: 500,
    });
    useCostStore.getState().reset();
    const s = useCostStore.getState();
    expect(s.totalInputTokens).toBe(0);
    expect(s.totalOutputTokens).toBe(0);
    expect(s.totalUsd).toBe(0);
    expect(s.callCount).toBe(0);
  });

  it('unknown models contribute 0 to USD but still count tokens', () => {
    useCostStore.getState().record('claude-unknown-42', {
      input_tokens: 1000,
      output_tokens: 500,
    });
    const s = useCostStore.getState();
    expect(s.totalInputTokens).toBe(1000);
    expect(s.totalOutputTokens).toBe(500);
    expect(s.totalUsd).toBe(0);
    expect(s.callCount).toBe(1);
  });
});
