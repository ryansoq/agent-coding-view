import { describe, it, expect } from 'vitest';
import { findJsFunctions, importJs, findPyFunctions, importPy, importSource } from './importer';

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

  // --- Edge cases probed during bug hunt ---

  it('parses async functions', () => {
    const src = `async function fetchUser(id) { return await db.get(id); }`;
    const fns = findJsFunctions(src);
    expect(fns).toHaveLength(1);
    expect(fns[0].name).toBe('fetchUser');
    expect(fns[0].params).toBe('id');
  });

  it('parses generator functions', () => {
    const src = `function* range(n) { for (let i = 0; i < n; i++) yield i; }`;
    const fns = findJsFunctions(src);
    expect(fns).toHaveLength(1);
    expect(fns[0].name).toBe('range');
  });

  it('parses functions with default parameters', () => {
    const src = `function add(a, b = 0) { return a + b; }`;
    const fns = findJsFunctions(src);
    expect(fns).toHaveLength(1);
    expect(fns[0].params).toBe('a, b = 0');
  });

  it('parses functions with destructured params', () => {
    const src = `function take({ a, b }) { return a + b; }`;
    const fns = findJsFunctions(src);
    expect(fns).toHaveLength(1);
    expect(fns[0].params).toBe('{ a, b }');
  });

  it('does NOT pick up arrow functions assigned to const', () => {
    // MVP behaviour: only `function NAME` declarations are parsed.
    const src = `const foo = (x) => x + 1;`;
    expect(findJsFunctions(src)).toEqual([]);
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

describe('findPyFunctions', () => {
  it('empty source yields no functions', () => {
    expect(findPyFunctions('')).toEqual([]);
  });

  it('parses a simple def with multi-line body', () => {
    const src = `def greet(name):
    print('hi', name)
    return name`;
    const fns = findPyFunctions(src);
    expect(fns).toHaveLength(1);
    expect(fns[0].name).toBe('greet');
    expect(fns[0].params).toBe('name');
    expect(fns[0].body).toBe("print('hi', name)\nreturn name");
  });

  it('dedents 8-space-indented bodies correctly', () => {
    const src = `def foo(x):
        if x:
            return 1
        return 0`;
    const fns = findPyFunctions(src);
    expect(fns[0].body).toBe('if x:\n    return 1\nreturn 0');
  });

  it('parses async def', () => {
    const src = `async def fetch(url):
    return await http.get(url)`;
    const fns = findPyFunctions(src);
    expect(fns).toHaveLength(1);
    expect(fns[0].name).toBe('fetch');
  });

  it('parses type-annotated def with return type', () => {
    const src = `def add(a: int, b: int = 0) -> int:
    return a + b`;
    const fns = findPyFunctions(src);
    expect(fns).toHaveLength(1);
    expect(fns[0].params).toBe('a: int, b: int = 0');
    expect(fns[0].body).toBe('return a + b');
  });

  it('parses multiple top-level defs', () => {
    const src = `def a():
    return 1

def b(x):
    return x + 1`;
    const fns = findPyFunctions(src);
    expect(fns).toHaveLength(2);
    expect(fns.map((f) => f.name)).toEqual(['a', 'b']);
  });

  it('does NOT surface indented defs (class methods, nested)', () => {
    const src = `class Foo:
    def method(self):
        return 1

def top():
    def inner():
        return 2
    return inner()`;
    const fns = findPyFunctions(src);
    expect(fns).toHaveLength(1);
    expect(fns[0].name).toBe('top');
    // The nested `def inner` stays inside top's body
    expect(fns[0].body).toContain('def inner():');
  });

  it('handles trailing comment on the def line', () => {
    const src = `def foo(x):  # pragma: no cover
    return x`;
    const fns = findPyFunctions(src);
    expect(fns).toHaveLength(1);
    expect(fns[0].name).toBe('foo');
  });

  it('trims trailing blank lines from body', () => {
    const src = `def foo():
    return 1


`;
    const fns = findPyFunctions(src);
    expect(fns[0].body).toBe('return 1');
  });
});

describe('importPy', () => {
  it('produces python blocks with def-style signature', () => {
    const src = `def slug(s):
    return s.lower()`;
    const result = importPy(src);
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].data.language).toBe('python');
    expect(result.nodes[0].data.signature).toBe('def slug(s)');
    expect(result.nodes[0].data.body).toBe('return s.lower()');
  });
});

describe('importSource', () => {
  it('dispatches to importJs by default', () => {
    const result = importSource('function foo() {}', 'graph.js');
    expect(result.nodes[0].data.language).toBe('javascript');
  });

  it('dispatches to importPy for .py extension', () => {
    const result = importSource('def foo():\n    pass', 'graph.py');
    expect(result.nodes[0].data.language).toBe('python');
  });

  it('case-insensitive extension match', () => {
    const result = importSource('def foo():\n    pass', 'GRAPH.PY');
    expect(result.nodes[0].data.language).toBe('python');
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
