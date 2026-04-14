import { describe, it, expect } from 'vitest';
import { extractCodeBlock } from './llm';

describe('extractCodeBlock', () => {
  it('extracts content from a plain fenced block', () => {
    const input = '```js\nreturn x + 1;\n```';
    expect(extractCodeBlock(input)).toBe('return x + 1;');
  });

  it('extracts from fence without language tag', () => {
    const input = '```\nreturn x;\n```';
    expect(extractCodeBlock(input)).toBe('return x;');
  });

  it('unwraps a JS function declaration', () => {
    const input = '```js\nfunction foo(x) {\n  return x + 1;\n}\n```';
    expect(extractCodeBlock(input)).toBe('return x + 1;');
  });

  it('unwraps an arrow function assigned to const', () => {
    const input = '```js\nconst foo = (x) => {\n  return x + 1;\n};\n```';
    expect(extractCodeBlock(input)).toBe('return x + 1;');
  });

  it('unwraps an async arrow function', () => {
    const input = '```js\nconst foo = async (x) => {\n  return x;\n};\n```';
    expect(extractCodeBlock(input)).toBe('return x;');
  });

  it('unwraps a Python def', () => {
    const input = '```python\ndef foo(x):\n    return x + 1\n```';
    expect(extractCodeBlock(input)).toBe('return x + 1');
  });

  it('unwraps an async Python def', () => {
    const input = '```python\nasync def foo(x):\n    return x\n```';
    expect(extractCodeBlock(input)).toBe('return x');
  });

  it('unwraps a Python def with return type annotation', () => {
    const input = '```python\ndef foo(x: int) -> int:\n    return x + 1\n```';
    expect(extractCodeBlock(input)).toBe('return x + 1');
  });

  it('dedents multi-line Python bodies', () => {
    const input =
      '```python\ndef foo(x):\n    if x < 0:\n        return 0\n    return x\n```';
    expect(extractCodeBlock(input)).toBe('if x < 0:\n    return 0\nreturn x');
  });

  it('returns input as-is when no fence is present', () => {
    expect(extractCodeBlock('return x;')).toBe('return x;');
  });

  it('takes the first fence when multiple are present', () => {
    const input = '```js\nfoo;\n```\n```js\nbar;\n```';
    expect(extractCodeBlock(input)).toBe('foo;');
  });

  it('trims surrounding whitespace inside the fence', () => {
    const input = '```js\n\n  return 42;\n\n```';
    expect(extractCodeBlock(input)).toBe('return 42;');
  });

  it('keeps multi-statement body without a wrapper', () => {
    const input = '```js\nconst x = 1;\nreturn x + 2;\n```';
    expect(extractCodeBlock(input)).toBe('const x = 1;\nreturn x + 2;');
  });
});
