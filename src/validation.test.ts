import { describe, it, expect } from 'vitest';
import { Edge } from 'reactflow';
import { validateGraph, countIssues, computeStats } from './validation';
import { FBlockNode } from './store';
import { defaultBlockData, FunctionBlockData } from './types';

function node(id: string, data: Partial<FunctionBlockData> = {}): FBlockNode {
  return {
    id,
    type: 'fblock',
    position: { x: 0, y: 0 },
    data: { ...defaultBlockData(id), ...data },
  };
}

function edge(source: string, target: string): Edge {
  return { id: `${source}-${target}`, source, target };
}

function mkEdge(source: string, target: string, id = `${source}-${target}`): Edge {
  return { id, source, target };
}

describe('validateGraph', () => {
  it('empty graph has no issues', () => {
    expect(validateGraph([], [])).toEqual([]);
  });

  it('flags failing tests as errors', () => {
    const a = node('a', { name: 'broken', status: 'failing' });
    const issues = validateGraph([a], []);
    const errors = issues.filter((i) => i.severity === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('broken');
    expect(errors[0].message).toContain('failing');
  });

  it('flags cycle members as warnings', () => {
    const a = node('a', { name: 'A' });
    const b = node('b', { name: 'B' });
    const issues = validateGraph([a, b], [edge('a', 'b'), edge('b', 'a')]);
    const cycleWarnings = issues.filter((i) => i.message.includes('cycle'));
    expect(cycleWarnings).toHaveLength(2);
    expect(cycleWarnings.every((i) => i.severity === 'warning')).toBe(true);
  });

  it('flags duplicate names', () => {
    const a = node('a', { name: 'foo' });
    const b = node('b', { name: 'foo' });
    const issues = validateGraph([a, b], []);
    const dupWarnings = issues.filter((i) => i.message.includes('Duplicate'));
    expect(dupWarnings).toHaveLength(2);
    expect(dupWarnings[0].blockId).toBe('a');
    expect(dupWarnings[1].blockId).toBe('b');
  });

  it('does NOT flag unique names', () => {
    const a = node('a', { name: 'foo' });
    const b = node('b', { name: 'bar' });
    const issues = validateGraph([a, b], []);
    expect(issues.filter((i) => i.message.includes('Duplicate'))).toHaveLength(0);
  });

  it('flags TDD mode with no tests', () => {
    const a = node('a', { name: 'tdd_block', mode: 'TDD', tests: '' });
    const issues = validateGraph([a], []);
    expect(issues.some((i) => i.severity === 'warning' && i.message.includes('no tests'))).toBe(true);
  });

  it('does NOT flag TDD mode when tests are present', () => {
    const a = node('a', {
      name: 'tdd_block',
      mode: 'TDD',
      tests: 'test("x", () => {})',
    });
    const issues = validateGraph([a], []);
    expect(issues.some((i) => i.message.includes('no tests'))).toBe(false);
  });

  it('does NOT flag SDD blocks with no spec (would be too noisy for new blocks)', () => {
    const a = node('a', { name: 'sdd_block', mode: 'SDD', spec: '' });
    expect(validateGraph([a], [])).toEqual([]);
  });

  it('does NOT flag stub blocks with empty body (same reason)', () => {
    const a = node('a', { name: 'empty', body: '', status: 'stub' });
    expect(validateGraph([a], [])).toEqual([]);
  });

  it('does NOT flag passing blocks even if mode is TDD with tests', () => {
    const a = node('a', {
      name: 'good',
      mode: 'TDD',
      tests: 'test("x", () => {})',
      body: 'return 1;',
      status: 'passing',
    });
    expect(validateGraph([a], [])).toEqual([]);
  });
});

describe('countIssues', () => {
  it('groups counts by severity', () => {
    const a = node('a', { name: 'failing', status: 'failing' }); // error
    const b = node('b', { name: 'tdd_no_tests', mode: 'TDD', tests: '' }); // warning
    const c = node('c', { name: 'ok', status: 'specd', spec: 'has one' }); // clean
    const counts = countIssues([a, b, c], []);
    expect(counts.errors).toBe(1);
    expect(counts.warnings).toBe(1);
    expect(counts.infos).toBe(0);
    expect(counts.total).toBe(2);
  });

  it('returns zeros for a clean graph', () => {
    const a = node('a', {
      name: 'clean',
      mode: 'SDD',
      spec: 'does the thing',
      body: 'return 1;',
      status: 'specd',
    });
    expect(countIssues([a], [])).toEqual({ errors: 0, warnings: 0, infos: 0, total: 0 });
  });
});

describe('computeStats', () => {
  it('empty graph returns zeros', () => {
    const s = computeStats([], []);
    expect(s.blocks).toBe(0);
    expect(s.edges).toBe(0);
    expect(s.languages).toEqual({});
    expect(s.modes).toEqual({});
    expect(s.passing).toBe(0);
    expect(s.failing).toBe(0);
  });

  it('counts blocks and edges', () => {
    const a = node('a');
    const b = node('b');
    const s = computeStats([a, b], [{ id: 'e1', source: 'a', target: 'b' }]);
    expect(s.blocks).toBe(2);
    expect(s.edges).toBe(1);
  });

  it('tallies language distribution', () => {
    const blocks = [
      node('a', { language: 'javascript' }),
      node('b', { language: 'javascript' }),
      node('c', { language: 'python' }),
      node('d', { language: '' }),
    ];
    const s = computeStats(blocks, []);
    expect(s.languages).toEqual({ javascript: 2, python: 1, '(inherited)': 1 });
  });

  it('tallies mode distribution', () => {
    const blocks = [
      node('a', { mode: 'TDD' }),
      node('b', { mode: 'TDD' }),
      node('c', { mode: 'SDD' }),
      node('d', { mode: 'manual' }),
    ];
    const s = computeStats(blocks, []);
    expect(s.modes).toEqual({ TDD: 2, SDD: 1, manual: 1 });
  });

  it('counts passing and failing', () => {
    const blocks = [
      node('a', { status: 'passing' }),
      node('b', { status: 'passing' }),
      node('c', { status: 'failing' }),
      node('d', { status: 'specd' }),
    ];
    const s = computeStats(blocks, []);
    expect(s.passing).toBe(2);
    expect(s.failing).toBe(1);
  });

  it('longestChain: empty graph is 0', () => {
    expect(computeStats([], []).longestChain).toBe(0);
  });

  it('longestChain: isolated blocks are 1', () => {
    const s = computeStats([node('a'), node('b'), node('c')], []);
    expect(s.longestChain).toBe(1);
  });

  it('longestChain: linear chain a→b→c is 3', () => {
    const nodes = [node('a'), node('b'), node('c')];
    const edges = [mkEdge('a', 'b'), mkEdge('b', 'c')];
    expect(computeStats(nodes, edges).longestChain).toBe(3);
  });

  it('longestChain: diamond takes the longer branch', () => {
    // a → b → d (3)
    //  \       /
    //   → c →
    const nodes = [node('a'), node('b'), node('c'), node('d')];
    const edges = [mkEdge('a', 'b'), mkEdge('a', 'c'), mkEdge('b', 'd'), mkEdge('c', 'd')];
    expect(computeStats(nodes, edges).longestChain).toBe(3);
  });

  it('components: three isolated blocks → 3 components', () => {
    expect(computeStats([node('a'), node('b'), node('c')], []).components).toBe(3);
  });

  it('components: chain a→b→c → 1 component', () => {
    const nodes = [node('a'), node('b'), node('c')];
    const edges = [mkEdge('a', 'b'), mkEdge('b', 'c')];
    expect(computeStats(nodes, edges).components).toBe(1);
  });

  it('components: two disjoint chains → 2 components', () => {
    const nodes = [node('a'), node('b'), node('c'), node('d')];
    const edges = [mkEdge('a', 'b'), mkEdge('c', 'd')];
    expect(computeStats(nodes, edges).components).toBe(2);
  });

  it('components: edges are treated as undirected', () => {
    // a → b ← c should still be 1 component
    const nodes = [node('a'), node('b'), node('c')];
    const edges = [mkEdge('a', 'b'), mkEdge('c', 'b')];
    expect(computeStats(nodes, edges).components).toBe(1);
  });

  it('seed-shaped graph: parseInput→validate, parseInput→enrich, py_slug isolated', () => {
    const nodes = [node('parseInput'), node('validate'), node('enrich'), node('py_slug')];
    const edges = [
      mkEdge('parseInput', 'validate'),
      mkEdge('parseInput', 'enrich'),
    ];
    const s = computeStats(nodes, edges);
    expect(s.longestChain).toBe(2); // parseInput → validate (or enrich)
    expect(s.components).toBe(2); // connected trio + isolated py_slug
    expect(s.maxFanOut).toBe(2); // parseInput has two outgoing edges
    expect(s.maxFanIn).toBe(1); // validate and enrich each have one incoming
  });

  it('maxFanIn / maxFanOut: zero for an empty graph', () => {
    const s = computeStats([], []);
    expect(s.maxFanIn).toBe(0);
    expect(s.maxFanOut).toBe(0);
  });

  it('maxFanIn / maxFanOut: zero when there are no edges', () => {
    const s = computeStats([node('a'), node('b')], []);
    expect(s.maxFanIn).toBe(0);
    expect(s.maxFanOut).toBe(0);
  });

  it('maxFanIn picks up a block with many incoming edges', () => {
    // hub receives from a, b, c, d
    const nodes = [node('a'), node('b'), node('c'), node('d'), node('hub')];
    const edges = [
      mkEdge('a', 'hub'),
      mkEdge('b', 'hub'),
      mkEdge('c', 'hub'),
      mkEdge('d', 'hub'),
    ];
    const s = computeStats(nodes, edges);
    expect(s.maxFanIn).toBe(4);
    expect(s.maxFanOut).toBe(1);
  });

  it('maxFanOut picks up a block with many outgoing edges', () => {
    // source → a, b, c
    const nodes = [node('source'), node('a'), node('b'), node('c')];
    const edges = [
      mkEdge('source', 'a'),
      mkEdge('source', 'b'),
      mkEdge('source', 'c'),
    ];
    const s = computeStats(nodes, edges);
    expect(s.maxFanOut).toBe(3);
    expect(s.maxFanIn).toBe(1);
  });

  it('fan stats ignore edges pointing at dangling ids', () => {
    const nodes = [node('a')];
    const edges = [mkEdge('a', 'ghost'), mkEdge('ghost', 'a')];
    const s = computeStats(nodes, edges);
    expect(s.maxFanIn).toBe(0);
    expect(s.maxFanOut).toBe(0);
  });
});
