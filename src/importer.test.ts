import { describe, it, expect } from 'vitest';
import { findJsFunctions, importJs } from './importer';

describe('findJsFunctions', () => {
  it('empty source yields no functions', () => {
    expect(findJsFunctions('')).toEqual([]);
  });

  it('finds a single function declaration', () => {
    const src = 'function foo(x) { return x + 1; }';
    expect(findJsFunctions(src)).toEqual([{ name: 'foo', params: 'x', body: 'return x + 1;' }]);
  });

  it('finds multiple top-level functions', () => {
    const src = `
      function a() { return 1; }
      function b(x, y) { return x + y; }
    `;
    const fns = findJsFunctions(src);
    expect(fns).toHaveLength(2);
    expect(fns.map((f) => f.name)).toEqual(['a', 'b']);
    expect(fns[1].params).toBe('x, y');
  });

  it('handles nested braces in body', () => {
    const src = `function f(x) { if (x) { return 1; } return 0; }`;
    const fns = findJsFunctions(src);
    expect(fns).toHaveLength(1);
    expect(fns[0].body).toContain('if (x) { return 1; }');
    expect(fns[0].body).toContain('return 0;');
  });

  it('handles nested parens in params', () => {
    const src = `function compose(f, g) { return function (x) { return f(g(x)); }; }`;
    const fns = findJsFunctions(src);
    expect(fns).toHaveLength(1);
    expect(fns[0].name).toBe('compose');
    expect(fns[0].params).toBe('f, g');
  });

  it('does NOT recurse into inner function declarations', () => {
    const src = `
      function outer(x) {
        function inner(y) { return y; }
        return inner(x);
      }
    `;
    const fns = findJsFunctions(src);
    // MVP behaviour: only top-level functions are surfaced.
    expect(fns).toHaveLength(1);
    expect(fns[0].name).toBe('outer');
  });

  it('skips function-like text inside string literals', () => {
    const src = `function real(x) { return "function fake() { ignored; }"; }`;
    const fns = findJsFunctions(src);
    expect(fns).toHaveLength(1);
    expect(fns[0].name).toBe('real');
  });

  it('skips function-like text inside line comments', () => {
    const src = `// function ignored() { wat }
function kept(x) { return x; }`;
    const fns = findJsFunctions(src);
    expect(fns).toHaveLength(1);
    expect(fns[0].name).toBe('kept');
  });

  it('skips function-like text inside block comments', () => {
    const src = `/* function ignored() { wat } */ function kept(x) { return x; }`;
    const fns = findJsFunctions(src);
    expect(fns).toHaveLength(1);
    expect(fns[0].name).toBe('kept');
  });
});

describe('importJs', () => {
  it('produces blocks with signature/body and column layout', () => {
    const src = `function a() { return 1; }
function b(x) { return x + 1; }`;
    const result = importJs(src);
    expect(result.nodes).toHaveLength(2);
    expect(result.edges).toEqual([]);
    expect(result.nodes[0].data.name).toBe('a');
    expect(result.nodes[0].data.signature).toBe('()');
    expect(result.nodes[0].data.body).toBe('return 1;');
    expect(result.nodes[1].data.name).toBe('b');
    expect(result.nodes[1].data.signature).toBe('(x)');
    // Column layout: each node lower than the previous
    expect(result.nodes[1].position.y).toBeGreaterThan(result.nodes[0].position.y);
  });

  it('language defaults to javascript', () => {
    const result = importJs('function foo() {}');
    expect(result.nodes[0].data.language).toBe('javascript');
  });
});

describe('round-trip with exporter', () => {
  it('exporter → importer → exporter is stable', async () => {
    // Lazy import to avoid circular concerns
    const { exportToJs } = await import('./exporter');
    const original = importJs(`function double(x) { return x * 2; }
function quad(x) { return double(double(x)); }`);
    const code1 = exportToJs(original.nodes);
    const reimported = importJs(code1);
    const code2 = exportToJs(reimported.nodes);
    expect(code2).toBe(code1);
    expect(reimported.nodes.map((n) => n.data.name)).toEqual(['double', 'quad']);
  });
});
