import { beforeEach, describe, it, expect } from 'vitest';
import { TEMPLATES } from './templates';
import { useGraphStore } from './store';

beforeEach(() => {
  useGraphStore.setState({
    nodes: [],
    edges: [],
    history: [],
    future: [],
  });
});

describe('TEMPLATES', () => {
  it('every template has a unique id', () => {
    const ids = TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every template has label, description, and data', () => {
    for (const t of TEMPLATES) {
      expect(t.label).toBeTruthy();
      expect(t.description).toBeTruthy();
      expect(t.data).toBeTruthy();
    }
  });

  it('every template with TDD mode has tests', () => {
    for (const t of TEMPLATES) {
      if (t.data.mode === 'TDD') {
        expect(t.data.tests, `template ${t.id} is TDD but has no tests`).toBeTruthy();
      }
    }
  });
});

describe('addBlock with template overrides', () => {
  it('seeds the new block with template data', () => {
    const tpl = TEMPLATES.find((t) => t.id === 'js-pure')!;
    useGraphStore.getState().addBlock(undefined, tpl.data);
    const state = useGraphStore.getState();
    expect(state.nodes).toHaveLength(1);
    const block = state.nodes[0].data;
    expect(block.name).toBe(tpl.data.name);
    expect(block.signature).toBe(tpl.data.signature);
    expect(block.tests).toBe(tpl.data.tests);
    expect(block.language).toBe(tpl.data.language);
    expect(block.mode).toBe(tpl.data.mode);
  });

  it('template block is auto-selected like a normal addBlock', () => {
    const tpl = TEMPLATES.find((t) => t.id === 'py-list')!;
    useGraphStore.getState().addBlock(undefined, tpl.data);
    expect(useGraphStore.getState().nodes[0].selected).toBe(true);
  });

  it('template adds push history so undo works', () => {
    const tpl = TEMPLATES.find((t) => t.id === 'js-validator')!;
    useGraphStore.getState().addBlock(undefined, tpl.data);
    expect(useGraphStore.getState().nodes).toHaveLength(1);
    useGraphStore.getState().undo();
    expect(useGraphStore.getState().nodes).toHaveLength(0);
  });
});
