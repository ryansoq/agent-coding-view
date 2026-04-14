import { beforeEach, describe, it, expect } from 'vitest';
import { useGraphStore } from './store';

/**
 * The store module initialises with seed data, a non-empty history is not
 * used at module load (history is []). To get a deterministic starting point
 * for each test, we reset to empty before every case.
 */
beforeEach(() => {
  useGraphStore.setState({
    nodes: [],
    edges: [],
    history: [],
    future: [],
  });
});

function state() {
  return useGraphStore.getState();
}

describe('store — structural mutations', () => {
  it('addBlock appends a new selected node', () => {
    state().addBlock({ x: 0, y: 0 });
    const s = state();
    expect(s.nodes).toHaveLength(1);
    expect(s.nodes[0].selected).toBe(true);
  });

  it('addBlock deselects previously selected nodes', () => {
    state().addBlock({ x: 0, y: 0 });
    state().addBlock({ x: 100, y: 100 });
    const s = state();
    expect(s.nodes).toHaveLength(2);
    expect(s.nodes.filter((n) => n.selected)).toHaveLength(1);
    expect(s.nodes[1].selected).toBe(true);
  });

  it('duplicateBlock clones data and offsets position', () => {
    state().addBlock({ x: 100, y: 200 });
    const originalId = state().nodes[0].id;
    state().patchBlock(originalId, { name: 'original', scope: ['src/a.ts'] });
    state().duplicateBlock(originalId);

    const s = state();
    expect(s.nodes).toHaveLength(2);
    const clone = s.nodes[1];
    expect(clone.data.name).toBe('original_copy');
    expect(clone.data.scope).toEqual(['src/a.ts']);
    // Mutating the clone's scope should NOT affect the original (deep clone).
    clone.data.scope.push('src/b.ts');
    expect(s.nodes[0].data.scope).toEqual(['src/a.ts']);
    expect(clone.position).toEqual({ x: 140, y: 240 });
    expect(clone.selected).toBe(true);
    expect(s.nodes[0].selected).toBe(false);
  });

  it('onConnect rejects self-loops', () => {
    state().addBlock({ x: 0, y: 0 });
    const id = state().nodes[0].id;
    state().onConnect({ source: id, target: id, sourceHandle: null, targetHandle: null });
    expect(state().edges).toHaveLength(0);
  });

  it('onConnect dedupes (source, target) pairs', () => {
    state().addBlock({ x: 0, y: 0 });
    state().addBlock({ x: 100, y: 100 });
    const [a, b] = state().nodes;
    state().onConnect({ source: a.id, target: b.id, sourceHandle: null, targetHandle: null });
    state().onConnect({ source: a.id, target: b.id, sourceHandle: null, targetHandle: null });
    expect(state().edges).toHaveLength(1);
  });
});

describe('store — undo/redo', () => {
  it('undo restores state after addBlock', () => {
    state().addBlock({ x: 0, y: 0 });
    expect(state().nodes).toHaveLength(1);
    state().undo();
    expect(state().nodes).toHaveLength(0);
  });

  it('redo re-applies an undone addBlock', () => {
    state().addBlock({ x: 0, y: 0 });
    state().undo();
    state().redo();
    expect(state().nodes).toHaveLength(1);
  });

  it('undo is a no-op when history is empty', () => {
    state().undo();
    expect(state().nodes).toEqual([]);
    expect(state().history).toEqual([]);
  });

  it('redo is a no-op when future is empty', () => {
    state().addBlock({ x: 0, y: 0 });
    state().redo();
    expect(state().nodes).toHaveLength(1);
  });

  it('a new mutation after undo clears the redo stack', () => {
    state().addBlock({ x: 0, y: 0 });
    state().addBlock({ x: 100, y: 0 });
    state().undo();
    expect(state().future).toHaveLength(1);
    // New mutation should clobber the redo future
    state().addBlock({ x: 200, y: 0 });
    expect(state().future).toHaveLength(0);
  });

  it('patchBlock does NOT push history (live fine-grained updates)', () => {
    state().addBlock({ x: 0, y: 0 });
    const id = state().nodes[0].id;
    const historyLenBefore = state().history.length;
    state().patchBlock(id, { name: 'renamed' });
    expect(state().history).toHaveLength(historyLenBefore);
  });

  it('appendBlockBody does NOT push history (streaming)', () => {
    state().addBlock({ x: 0, y: 0 });
    const id = state().nodes[0].id;
    const historyLenBefore = state().history.length;
    state().appendBlockBody(id, 'hello');
    state().appendBlockBody(id, ' world');
    expect(state().history).toHaveLength(historyLenBefore);
  });

  it('history caps at 50 entries', () => {
    for (let i = 0; i < 60; i++) state().addBlock({ x: i, y: 0 });
    expect(state().history.length).toBe(50);
    expect(state().nodes).toHaveLength(60);
  });

  it('undo after deleteSelected brings the node back with its data', () => {
    state().addBlock({ x: 0, y: 0 });
    const id = state().nodes[0].id;
    state().patchBlock(id, { name: 'keep me', spec: 'important spec' });
    // Deselect others (already done), mark node as selected — addBlock does this.
    state().deleteSelected();
    expect(state().nodes).toEqual([]);
    state().undo();
    expect(state().nodes).toHaveLength(1);
    expect(state().nodes[0].data.name).toBe('keep me');
    expect(state().nodes[0].data.spec).toBe('important spec');
  });
});

describe('store — fromJSON', () => {
  it('merges loaded nodes with defaults so missing fields fall back', () => {
    const raw = JSON.stringify({
      version: 1,
      nodes: [
        {
          id: 'b1',
          position: { x: 0, y: 0 },
          // Intentionally omit most fields — older save files.
          data: { name: 'sparse', signature: '(x) => x' },
        },
      ],
      edges: [],
    });
    state().fromJSON(raw);
    const loaded = state().nodes[0];
    expect(loaded.data.name).toBe('sparse');
    expect(loaded.data.mode).toBe('SDD'); // default
    expect(loaded.data.scope).toEqual([]); // default
    expect(loaded.data.status).toBe('stub'); // default
  });

  it('filters out edges pointing at non-existent nodes', () => {
    const raw = JSON.stringify({
      version: 1,
      nodes: [
        { id: 'b1', position: { x: 0, y: 0 }, data: { name: 'a' } },
        { id: 'b2', position: { x: 0, y: 0 }, data: { name: 'b' } },
      ],
      edges: [
        { id: 'e1', source: 'b1', target: 'b2' },
        { id: 'e2', source: 'b1', target: 'ghost' }, // dangling
        { id: 'e3', source: 'b1', target: 'b1' },    // self-loop
      ],
    });
    state().fromJSON(raw);
    expect(state().edges).toHaveLength(1);
    expect(state().edges[0].id).toBe('e1');
  });

  it('rejects malformed top-level shape', () => {
    expect(() => state().fromJSON('{}')).toThrow(/expected/);
    expect(() => state().fromJSON('not json')).toThrow();
  });

  it('load is itself undoable', () => {
    state().addBlock({ x: 0, y: 0 });
    const beforeLoad = state().nodes.length;
    state().fromJSON(
      JSON.stringify({
        version: 1,
        nodes: [{ id: 'loaded', position: { x: 0, y: 0 }, data: { name: 'loaded' } }],
        edges: [],
      }),
    );
    expect(state().nodes).toHaveLength(1);
    expect(state().nodes[0].data.name).toBe('loaded');
    state().undo();
    expect(state().nodes).toHaveLength(beforeLoad);
  });
});
