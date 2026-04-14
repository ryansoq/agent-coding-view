import { describe, it, expect } from 'vitest';
import { Edge } from 'reactflow';
import { detectCycles } from './graph';
import { FBlockNode } from './store';
import { defaultBlockData } from './types';

function node(id: string): FBlockNode {
  return {
    id,
    type: 'fblock',
    position: { x: 0, y: 0 },
    data: defaultBlockData(id),
  };
}

function edge(source: string, target: string): Edge {
  return { id: `${source}-${target}`, source, target };
}

describe('detectCycles', () => {
  it('empty graph has no cycles', () => {
    expect(detectCycles([], [])).toEqual(new Set());
  });

  it('single node has no cycles', () => {
    expect(detectCycles([node('a')], [])).toEqual(new Set());
  });

  it('linear chain has no cycles', () => {
    const nodes = [node('a'), node('b'), node('c')];
    const edges = [edge('a', 'b'), edge('b', 'c')];
    expect(detectCycles(nodes, edges)).toEqual(new Set());
  });

  it('diamond DAG has no cycles', () => {
    const nodes = [node('a'), node('b'), node('c'), node('d')];
    const edges = [
      edge('a', 'b'),
      edge('a', 'c'),
      edge('b', 'd'),
      edge('c', 'd'),
    ];
    expect(detectCycles(nodes, edges)).toEqual(new Set());
  });

  it('simple 2-cycle is detected', () => {
    const nodes = [node('a'), node('b')];
    const edges = [edge('a', 'b'), edge('b', 'a')];
    expect(detectCycles(nodes, edges)).toEqual(new Set(['a', 'b']));
  });

  it('3-cycle is detected', () => {
    const nodes = [node('a'), node('b'), node('c')];
    const edges = [edge('a', 'b'), edge('b', 'c'), edge('c', 'a')];
    expect(detectCycles(nodes, edges)).toEqual(new Set(['a', 'b', 'c']));
  });

  it('cycle plus outside nodes — only cycle nodes flagged', () => {
    const nodes = [node('a'), node('b'), node('c'), node('d')];
    // d → a → b → c → a forms a cycle on a, b, c; d feeds in but isn't in it.
    const edges = [edge('d', 'a'), edge('a', 'b'), edge('b', 'c'), edge('c', 'a')];
    expect(detectCycles(nodes, edges)).toEqual(new Set(['a', 'b', 'c']));
  });

  it('self-loop is detected defensively', () => {
    const nodes = [node('a')];
    const edges = [edge('a', 'a')];
    expect(detectCycles(nodes, edges)).toEqual(new Set(['a']));
  });

  it('two disjoint cycles both detected', () => {
    const nodes = [node('a'), node('b'), node('c'), node('d')];
    const edges = [edge('a', 'b'), edge('b', 'a'), edge('c', 'd'), edge('d', 'c')];
    expect(detectCycles(nodes, edges)).toEqual(new Set(['a', 'b', 'c', 'd']));
  });

  it('ignores edges pointing to non-existent nodes', () => {
    const nodes = [node('a')];
    const edges = [edge('a', 'ghost')];
    expect(detectCycles(nodes, edges)).toEqual(new Set());
  });
});
