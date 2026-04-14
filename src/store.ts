import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  Node,
  Edge,
  Connection,
  addEdge,
  applyNodeChanges,
  applyEdgeChanges,
  NodeChange,
  EdgeChange,
} from 'reactflow';
import { FunctionBlockData, defaultBlockData } from './types';
import { LANGUAGES } from './languages';
import { useSettingsStore } from './settingsStore';

export type FBlockNode = Node<FunctionBlockData>;

interface Snapshot {
  nodes: FBlockNode[];
  edges: Edge[];
}

interface GraphState {
  nodes: FBlockNode[];
  edges: Edge[];

  history: Snapshot[];
  future: Snapshot[];

  onNodesChange: (changes: NodeChange[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (conn: Connection) => void;

  addBlock: (at?: { x: number; y: number }) => void;
  deleteSelected: () => void;
  duplicateBlock: (id: string) => void;
  selectOnly: (id: string) => void;
  applyLayout: (positions: Record<string, { x: number; y: number }>) => void;
  patchBlock: (id: string, patch: Partial<FunctionBlockData>) => void;
  appendBlockBody: (id: string, delta: string) => void;
  resetBlockBody: (id: string) => void;

  undo: () => void;
  redo: () => void;

  toJSON: () => string;
  fromJSON: (raw: string) => void;
  reset: () => void;
}

let idCounter = 1;
const nextId = () => `b${idCounter++}`;

let edgeCounter = 1;
const nextEdgeId = () => `e${edgeCounter++}`;

// ---------------------------------------------------------------------------
// Undo history
// ---------------------------------------------------------------------------

const HISTORY_CAPACITY = 50;

function snap(state: Pick<GraphState, 'nodes' | 'edges'>): Snapshot {
  // Shallow-clone at every level we mutate on undo/redo. Node.data itself is
  // mostly treated as immutable elsewhere, but scope is an array we extend
  // in place via the Inspector's onChange, so duplicate it defensively.
  return {
    nodes: state.nodes.map((n) => ({
      ...n,
      data: { ...n.data, scope: [...n.data.scope] },
    })),
    edges: state.edges.map((e) => ({ ...e })),
  };
}

/**
 * Helper used at the start of structural mutations. Returns the state slice
 * that pushes the *current* pre-mutation state onto the history stack and
 * clears the redo queue — merge it into whatever else the mutation returns.
 */
function pushHistory(state: GraphState): Pick<GraphState, 'history' | 'future'> {
  const next = [...state.history, snap(state)];
  if (next.length > HISTORY_CAPACITY) next.shift();
  return { history: next, future: [] };
}

// ---------------------------------------------------------------------------
// Seed data
// ---------------------------------------------------------------------------

const seedNodes: FBlockNode[] = [
  {
    id: nextId(),
    type: 'fblock',
    position: { x: 80, y: 120 },
    data: {
      ...defaultBlockData('parseInput'),
      signature: '(raw: string) => Parsed',
      mode: 'SDD',
      spec: 'Parse a raw user query into structured form.',
      status: 'specd',
    },
  },
  {
    id: nextId(),
    type: 'fblock',
    position: { x: 440, y: 80 },
    data: {
      ...defaultBlockData('validate'),
      signature: '(s) => string',
      mode: 'TDD',
      language: 'javascript',
      tests: `test('rejects empty', () => {
  expect(() => validate('')).toThrow('empty');
});
test('accepts non-empty', () => {
  expect(validate('hello')).toBe('hello');
});
test('trims whitespace', () => {
  expect(validate('  hi  ')).toBe('hi');
});`,
      body: `const trimmed = s.trim();
if (!trimmed) throw new Error('empty');
return trimmed;`,
      status: 'specd',
    },
  },
  {
    id: nextId(),
    type: 'fblock',
    position: { x: 440, y: 300 },
    data: {
      ...defaultBlockData('enrich'),
      signature: '(p: Parsed) => Enriched',
      mode: 'manual',
      status: 'stub',
    },
  },
  {
    id: nextId(),
    type: 'fblock',
    position: { x: 80, y: 360 },
    data: {
      ...defaultBlockData('py_slug'),
      signature: 'def py_slug(s: str) -> str',
      mode: 'TDD',
      language: 'python',
      tests: `test('lowercases', lambda: expect(py_slug('Hello')).toBe('hello'))
test('replaces spaces with dashes', lambda: expect(py_slug('hi there')).toBe('hi-there'))
test('strips non-alnum', lambda: expect(py_slug('a!b@c#')).toBe('abc'))
test('rejects empty', lambda: expect(lambda: py_slug('')).toThrow('empty'))`,
      body: `import re
if not s:
    raise ValueError('empty')
lowered = s.lower().strip()
spaced = re.sub(r'\\s+', '-', lowered)
return re.sub(r'[^a-z0-9-]', '', spaced)`,
      status: 'specd',
    },
  },
];

const seedEdges: Edge[] = [
  { id: nextEdgeId(), source: seedNodes[0].id, target: seedNodes[1].id },
  { id: nextEdgeId(), source: seedNodes[0].id, target: seedNodes[2].id },
];

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useGraphStore = create<GraphState>()(
  persist(
    (set, get) => ({
  nodes: seedNodes,
  edges: seedEdges,
  history: [],
  future: [],

  onNodesChange: (changes) =>
    set((state) => {
      // Snapshot only on structural changes — drag/select would otherwise
      // spam the history stack with hundreds of entries per drag.
      const structural = changes.some(
        (c) => c.type === 'remove' || c.type === 'add',
      );
      const nodes = applyNodeChanges(changes, state.nodes) as FBlockNode[];
      return structural ? { ...pushHistory(state), nodes } : { nodes };
    }),

  onEdgesChange: (changes) =>
    set((state) => {
      const structural = changes.some(
        (c) => c.type === 'remove' || c.type === 'add',
      );
      const edges = applyEdgeChanges(changes, state.edges);
      return structural ? { ...pushHistory(state), edges } : { edges };
    }),

  onConnect: (conn) =>
    set((state) => {
      if (conn.source && conn.source === conn.target) return state;
      const exists = state.edges.some(
        (e) => e.source === conn.source && e.target === conn.target,
      );
      if (exists) return state;
      return {
        ...pushHistory(state),
        edges: addEdge({ ...conn, id: nextEdgeId() }, state.edges),
      };
    }),

  addBlock: (at) =>
    set((state) => {
      const id = nextId();
      const globalLang = useSettingsStore.getState().language;
      const langDef = LANGUAGES.find((l) => l.id === globalLang);
      const data = defaultBlockData(`block_${id}`);
      if (langDef) data.signature = langDef.sampleSignature;
      const node: FBlockNode = {
        id,
        type: 'fblock',
        position: at ?? { x: 200 + Math.random() * 300, y: 200 + Math.random() * 200 },
        data,
        selected: true,
      };
      const nodes = state.nodes.map((n) => (n.selected ? { ...n, selected: false } : n));
      nodes.push(node);
      return { ...pushHistory(state), nodes };
    }),

  duplicateBlock: (id) =>
    set((state) => {
      const source = state.nodes.find((n) => n.id === id);
      if (!source) return state;
      const newId = nextId();
      const clone: FBlockNode = {
        id: newId,
        type: 'fblock',
        position: { x: source.position.x + 40, y: source.position.y + 40 },
        data: {
          ...source.data,
          scope: [...source.data.scope],
          testCounts: source.data.testCounts ? { ...source.data.testCounts } : undefined,
          name: `${source.data.name}_copy`,
        },
        selected: true,
      };
      const nodes = state.nodes.map((n) => (n.selected ? { ...n, selected: false } : n));
      nodes.push(clone);
      return { ...pushHistory(state), nodes };
    }),

  deleteSelected: () =>
    set((state) => {
      const selectedNodeIds = new Set(state.nodes.filter((n) => n.selected).map((n) => n.id));
      const selectedEdgeIds = new Set(state.edges.filter((e) => e.selected).map((e) => e.id));
      if (selectedNodeIds.size === 0 && selectedEdgeIds.size === 0) return state;
      return {
        ...pushHistory(state),
        nodes: state.nodes.filter((n) => !selectedNodeIds.has(n.id)),
        edges: state.edges.filter(
          (e) =>
            !selectedEdgeIds.has(e.id) &&
            !selectedNodeIds.has(e.source) &&
            !selectedNodeIds.has(e.target),
        ),
      };
    }),

  applyLayout: (positions) =>
    set((state) => ({
      ...pushHistory(state),
      nodes: state.nodes.map((n) =>
        positions[n.id] ? { ...n, position: positions[n.id] } : n,
      ),
    })),

  // Selection-only change. Doesn't push history — consistent with drag/click
  // selection which also doesn't snapshot.
  selectOnly: (id) =>
    set((state) => ({
      nodes: state.nodes.map((n) => ({ ...n, selected: n.id === id })),
    })),

  // patchBlock, appendBlockBody, resetBlockBody are "live" fine-grained
  // updates (streaming deltas, status flips, form field edits). They
  // intentionally do NOT push history — undo is scoped to structural ops
  // (add/delete/connect/disconnect) plus load/clear.
  patchBlock: (id, patch) =>
    set((state) => ({
      nodes: state.nodes.map((n) =>
        n.id === id ? { ...n, data: { ...n.data, ...patch } } : n,
      ),
    })),

  appendBlockBody: (id, delta) =>
    set((state) => ({
      nodes: state.nodes.map((n) =>
        n.id === id ? { ...n, data: { ...n.data, body: n.data.body + delta } } : n,
      ),
    })),

  resetBlockBody: (id) =>
    set((state) => ({
      nodes: state.nodes.map((n) =>
        n.id === id ? { ...n, data: { ...n.data, body: '' } } : n,
      ),
    })),

  undo: () =>
    set((state) => {
      if (state.history.length === 0) return state;
      const prev = state.history[state.history.length - 1];
      const newHistory = state.history.slice(0, -1);
      return {
        nodes: prev.nodes,
        edges: prev.edges,
        history: newHistory,
        future: [...state.future, snap(state)],
      };
    }),

  redo: () =>
    set((state) => {
      if (state.future.length === 0) return state;
      const next = state.future[state.future.length - 1];
      const newFuture = state.future.slice(0, -1);
      return {
        nodes: next.nodes,
        edges: next.edges,
        history: [...state.history, snap(state)],
        future: newFuture,
      };
    }),

  toJSON: () => {
    const { nodes, edges } = get();
    return JSON.stringify(
      {
        version: 1,
        nodes: nodes.map(({ id, position, data }) => ({ id, position, data })),
        edges: edges.map(({ id, source, target }) => ({ id, source, target })),
      },
      null,
      2,
    );
  },

  fromJSON: (raw) => {
    const parsed = JSON.parse(raw) as {
      nodes?: Array<{ id: string; position: { x: number; y: number }; data: Partial<FunctionBlockData> }>;
      edges?: Array<{ id: string; source: string; target: string }>;
    };
    if (!parsed || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
      throw new Error('invalid graph file — expected { nodes: [], edges: [] }');
    }

    const nodes: FBlockNode[] = parsed.nodes.map((n) => ({
      id: n.id,
      type: 'fblock',
      position: n.position ?? { x: 0, y: 0 },
      data: {
        ...defaultBlockData(n.data?.name || n.id),
        ...n.data,
      },
    }));

    const nodeIds = new Set(nodes.map((n) => n.id));
    const edges = parsed.edges.filter(
      (e) =>
        e.source !== e.target && nodeIds.has(e.source) && nodeIds.has(e.target),
    );

    const maxNodeId = nodes
      .map((n) => Number(n.id.replace(/^b/, '')))
      .filter((n) => !Number.isNaN(n))
      .reduce((a, b) => Math.max(a, b), 0);
    idCounter = maxNodeId + 1;

    const maxEdgeId = edges
      .map((e) => Number(e.id.replace(/^e/, '')))
      .filter((n) => !Number.isNaN(n))
      .reduce((a, b) => Math.max(a, b), 0);
    edgeCounter = maxEdgeId + 1;

    // Loading a graph is structural enough to warrant an undo entry —
    // users often want to Ctrl+Z their way back from an accidental load.
    set((state) => ({ ...pushHistory(state), nodes, edges }));
  },

  reset: () =>
    set((state) => ({ ...pushHistory(state), nodes: [], edges: [] })),
    }),
    {
      name: 'agent-coding-view:graph',
      // Persist only structural data — history/future and any in-flight
      // selection state are session-local.
      partialize: (s) => ({ nodes: s.nodes, edges: s.edges }),
      // After hydration, sync the id counters so the next addBlock /
      // onConnect doesn't collide with persisted ids.
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        const maxNodeId = state.nodes
          .map((n) => Number(n.id.replace(/^b/, '')))
          .filter((n) => !Number.isNaN(n))
          .reduce((a, b) => Math.max(a, b), 0);
        if (maxNodeId >= idCounter) idCounter = maxNodeId + 1;
        const maxEdgeId = state.edges
          .map((e) => Number(e.id.replace(/^e/, '')))
          .filter((n) => !Number.isNaN(n))
          .reduce((a, b) => Math.max(a, b), 0);
        if (maxEdgeId >= edgeCounter) edgeCounter = maxEdgeId + 1;
      },
    },
  ),
);
