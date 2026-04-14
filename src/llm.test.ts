import { describe, it, expect } from 'vitest';
import { extractCodeBlock, buildUserPrompt } from './llm';
import { FunctionBlockData, defaultBlockData } from './types';

function block(overrides: Partial<FunctionBlockData> = {}): FunctionBlockData {
  return { ...defaultBlockData('foo'), ...overrides };
}

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

  it('unwraps function with nested parens in parameter type', () => {
    const input =
      '```js\nfunction foo(f: (x: number) => number) {\n  return f(1);\n}\n```';
    expect(extractCodeBlock(input)).toBe('return f(1);');
  });

  it('unwraps function with nested braces in body', () => {
    const input =
      '```js\nfunction foo(x) {\n  if (x) {\n    return 1;\n  }\n  return 0;\n}\n```';
    expect(extractCodeBlock(input)).toBe(
      'if (x) {\n    return 1;\n  }\n  return 0;',
    );
  });
});

describe('buildUserPrompt scope injection', () => {
  it('does not mention scope when scope is empty', () => {
    const prompt = buildUserPrompt({
      block: block({ scope: [] }),
      neighbors: [],
      language: 'typescript',
    });
    expect(prompt).not.toContain('Scope constraints');
  });

  it('injects scope globs when block.scope is non-empty', () => {
    const prompt = buildUserPrompt({
      block: block({ scope: ['src/feature/**/*.ts', 'src/utils/fmt.ts'] }),
      neighbors: [],
      language: 'typescript',
    });
    expect(prompt).toContain('Scope constraints');
    expect(prompt).toContain('- src/feature/**/*.ts');
    expect(prompt).toContain('- src/utils/fmt.ts');
    expect(prompt).toContain('Do NOT import from paths outside this scope');
  });

  it('includes neighbors section when neighbors are provided', () => {
    const prompt = buildUserPrompt({
      block: block({ name: 'child' }),
      neighbors: [
        { name: 'parent', signature: '(s: string) => Parsed', direction: 'upstream' },
        { name: 'sibling', signature: '(x: Parsed) => number', direction: 'downstream' },
      ],
      language: 'typescript',
    });
    expect(prompt).toContain('Neighbor functions');
    expect(prompt).toContain('[upstream] parent');
    expect(prompt).toContain('[downstream] sibling');
  });

  it('TDD mode surfaces the tests, not the spec', () => {
    const prompt = buildUserPrompt({
      block: block({
        mode: 'TDD',
        spec: 'This spec should be ignored',
        tests: `test('adds', () => expect(foo(1, 2)).toBe(3));`,
      }),
      neighbors: [],
      language: 'javascript',
    });
    expect(prompt).toContain('Tests this body must pass');
    expect(prompt).toContain("test('adds'");
    expect(prompt).not.toContain('This spec should be ignored');
  });

  it('previousAttempt feedback is injected verbatim when retrying', () => {
    const prompt = buildUserPrompt({
      block: block({ mode: 'TDD', tests: `test('x', () => {});` }),
      neighbors: [],
      language: 'javascript',
      previousAttempt: {
        body: 'return null;',
        failures: [{ name: 'x', error: 'expected 1, got null' }],
      },
    });
    expect(prompt).toContain('Your previous attempt');
    expect(prompt).toContain('return null;');
    expect(prompt).toContain('- x: expected 1, got null');
  });
});
