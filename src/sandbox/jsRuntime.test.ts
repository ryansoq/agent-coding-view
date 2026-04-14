// Tests the JS sandbox runtime end-to-end by assembling the same script the
// worker would run and executing it via `new Function()`. This is the ground
// truth: the test runtime is whatever this `new Function(script)()` produces,
// and these tests pin that behaviour.

import { describe, it, expect } from 'vitest';
import { JS_RUNTIME } from './jsRuntime';
import { extractParams, sanitizeName } from './runner';

interface TestCase {
  name: string;
  ok: boolean;
  error?: string;
}

function runInSandbox(opts: {
  name: string;
  signature: string;
  body: string;
  tests: string;
}): { status: 'done'; results: TestCase[] } | { status: 'error'; error: string } {
  const params = extractParams(opts.signature);
  const fnName = sanitizeName(opts.name);
  const userFn = `function ${fnName}(${params.join(', ')}) {\n${opts.body}\n}`;
  const script =
    JS_RUNTIME + '\n' + userFn + '\n' + opts.tests + '\nreturn __results;';
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    const runner = new Function(script);
    return { status: 'done', results: runner() as TestCase[] };
  } catch (err) {
    return { status: 'error', error: (err as Error).message };
  }
}

describe('JS sandbox runtime', () => {
  it('passes all tests when body is correct', () => {
    const r = runInSandbox({
      name: 'double',
      signature: '(x) => number',
      body: 'return x * 2;',
      tests: `test('doubles', () => expect(double(3)).toBe(6));`,
    });
    expect(r.status).toBe('done');
    if (r.status !== 'done') return;
    expect(r.results).toEqual([{ name: 'doubles', ok: true }]);
  });

  it('reports failures with "expected X, got Y" message', () => {
    const r = runInSandbox({
      name: 'broken',
      signature: '(x) => number',
      body: 'return x;',
      tests: `test('doubles', () => expect(broken(3)).toBe(6));`,
    });
    if (r.status !== 'done') throw new Error('expected done');
    expect(r.results[0].ok).toBe(false);
    expect(r.results[0].error).toContain('expected 6, got 3');
  });

  it('toEqual ignores object key order', () => {
    const r = runInSandbox({
      name: 'makeObj',
      signature: '() => object',
      body: 'return {a: 1, b: 2};',
      tests: `test('order free', () => expect(makeObj()).toEqual({b: 2, a: 1}));`,
    });
    if (r.status !== 'done') throw new Error('expected done');
    expect(r.results[0].ok).toBe(true);
  });

  it('toEqual handles nested structures', () => {
    const r = runInSandbox({
      name: 'nested',
      signature: '() => object',
      body: 'return {a: [1, 2, {b: 3}]};',
      tests: `test('deep', () => expect(nested()).toEqual({a: [1, 2, {b: 3}]}));`,
    });
    if (r.status !== 'done') throw new Error('expected done');
    expect(r.results[0].ok).toBe(true);
  });

  it('toEqual treats NaN as equal to NaN', () => {
    const r = runInSandbox({
      name: 'getNaN',
      signature: '() => number',
      body: 'return NaN;',
      tests: `test('nan', () => expect(getNaN()).toEqual(NaN));`,
    });
    if (r.status !== 'done') throw new Error('expected done');
    expect(r.results[0].ok).toBe(true);
  });

  it('toThrow matches error message substring', () => {
    const r = runInSandbox({
      name: 'boom',
      signature: '() => never',
      body: `throw new Error('something bad happened');`,
      tests: `test('throws', () => expect(() => boom()).toThrow('bad'));`,
    });
    if (r.status !== 'done') throw new Error('expected done');
    expect(r.results[0].ok).toBe(true);
  });

  it('toThrow fails when error message does not match', () => {
    const r = runInSandbox({
      name: 'boom',
      signature: '() => never',
      body: `throw new Error('oh no');`,
      tests: `test('throws bad', () => expect(() => boom()).toThrow('bad'));`,
    });
    if (r.status !== 'done') throw new Error('expected done');
    expect(r.results[0].ok).toBe(false);
    expect(r.results[0].error).toContain('expected error to include "bad"');
  });

  it('toThrow fails when callable does not throw', () => {
    const r = runInSandbox({
      name: 'safe',
      signature: '() => number',
      body: 'return 1;',
      tests: `test('throws', () => expect(() => safe()).toThrow());`,
    });
    if (r.status !== 'done') throw new Error('expected done');
    expect(r.results[0].ok).toBe(false);
    expect(r.results[0].error).toContain('expected function to throw');
  });

  it('preserves default parameter values', () => {
    const r = runInSandbox({
      name: 'mul',
      signature: '(a: number, b: number = 2) => number',
      body: 'return a * b;',
      tests: `test('default', () => expect(mul(3)).toBe(6));
test('explicit', () => expect(mul(3, 4)).toBe(12));`,
    });
    if (r.status !== 'done') throw new Error('expected done');
    expect(r.results.every((x) => x.ok)).toBe(true);
  });

  it('runtime error in body shows up as a failing test', () => {
    const r = runInSandbox({
      name: 'boom',
      signature: '(x) => x',
      body: `throw new Error('always');`,
      tests: `test('should not pass', () => expect(boom(1)).toBe(1));`,
    });
    if (r.status !== 'done') throw new Error('expected done');
    expect(r.results[0].ok).toBe(false);
    expect(r.results[0].error).toContain('always');
  });

  it('syntax error in tests surfaces as a top-level runtime error', () => {
    const r = runInSandbox({
      name: 'foo',
      signature: '(x) => x',
      body: 'return x;',
      tests: 'this is not valid javascript @@',
    });
    expect(r.status).toBe('error');
  });

  it('toBeCloseTo handles floating point rounding', () => {
    const r = runInSandbox({
      name: 'add',
      signature: '(a, b) => number',
      body: 'return a + b;',
      tests: `test('close', () => expect(add(0.1, 0.2)).toBeCloseTo(0.3));`,
    });
    if (r.status !== 'done') throw new Error('expected done');
    expect(r.results[0].ok).toBe(true);
  });

  it('empty tests block produces zero results', () => {
    const r = runInSandbox({
      name: 'foo',
      signature: '(x) => x',
      body: 'return x;',
      tests: '',
    });
    if (r.status !== 'done') throw new Error('expected done');
    expect(r.results).toEqual([]);
  });

  it('it() is an alias for test()', () => {
    const r = runInSandbox({
      name: 'id',
      signature: '(x) => x',
      body: 'return x;',
      tests: `it('aliased', () => expect(id(1)).toBe(1));`,
    });
    if (r.status !== 'done') throw new Error('expected done');
    expect(r.results).toEqual([{ name: 'aliased', ok: true }]);
  });

  // --- Edge cases uncovered during bug-hunt ---

  it('deepEqual: two identical Dates are equal', () => {
    const r = runInSandbox({
      name: 'makeDate',
      signature: '() => Date',
      body: `return new Date('2020-01-01');`,
      tests: `test('same', () => expect(makeDate()).toEqual(new Date('2020-01-01')));`,
    });
    if (r.status !== 'done') throw new Error('expected done');
    expect(r.results[0].ok).toBe(true);
  });

  it('deepEqual: two different Dates are NOT equal', () => {
    const r = runInSandbox({
      name: 'makeDate',
      signature: '() => Date',
      body: `return new Date('2020-01-01');`,
      tests: `test('diff', () => expect(makeDate()).toEqual(new Date('2021-06-15')));`,
    });
    if (r.status !== 'done') throw new Error('expected done');
    expect(r.results[0].ok).toBe(false);
  });

  it('deepEqual: two identical RegExps are equal', () => {
    const r = runInSandbox({
      name: 'makeRe',
      signature: '() => RegExp',
      body: `return /foo/gi;`,
      tests: `test('same', () => expect(makeRe()).toEqual(/foo/gi));`,
    });
    if (r.status !== 'done') throw new Error('expected done');
    expect(r.results[0].ok).toBe(true);
  });

  it('deepEqual: RegExps with different flags are NOT equal', () => {
    const r = runInSandbox({
      name: 'makeRe',
      signature: '() => RegExp',
      body: `return /foo/g;`,
      tests: `test('diff flags', () => expect(makeRe()).toEqual(/foo/i));`,
    });
    if (r.status !== 'done') throw new Error('expected done');
    expect(r.results[0].ok).toBe(false);
  });

  it('deepEqual: RegExps with different sources are NOT equal', () => {
    const r = runInSandbox({
      name: 'makeRe',
      signature: '() => RegExp',
      body: `return /foo/;`,
      tests: `test('diff source', () => expect(makeRe()).toEqual(/bar/));`,
    });
    if (r.status !== 'done') throw new Error('expected done');
    expect(r.results[0].ok).toBe(false);
  });
});
