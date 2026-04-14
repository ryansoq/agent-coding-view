import { create } from 'zustand';
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

interface GraphState {
  nodes: FBlockNode[];
  edges: Edge[];

  onNodesChange: (changes: NodeChange[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (conn: Connection) => void;

  addBlock: (at?: { x: number; y: number }) => void;
  deleteSelected: () => void;
  patchBlock: (id: string, patch: Partial<FunctionBlockData>) => void;
  appendBlockBody: (id: string, delta: string) => void;
  resetBlockBody: (id: string) => void;

  toJSON: () => string;
  fromJSON: (raw: string) => void;
  reset: () => void;
}

let idCounter = 1;
const nextId = () => `b${idCounter++}`;

let edgeCounter = 1;
const nextEdgeId = () => `e${edgeCounter++}`;

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

export const useGraphStore = create<GraphState>((set, get) => ({
  nodes: seedNodes,
  edges: seedEdges,

  onNodesChange: (changes) =>
    set((state) => ({
      nodes: applyNodeChanges(changes, state.nodes) as FBlockNode[],
    })),

  onEdgesChange: (changes) =>
    set((state) => ({ edges: applyEdgeChanges(changes, state.edges) })),

  onConnect: (conn) =>
    set((state) => {
      // Skip self-loops — a block calling itself via the graph surface isn't
      // representable in our neighbor model anyway.
      if (conn.source && conn.source === conn.target) return state;
      // Dedupe: React Flow will happily add a second edge between the same
      // source/target, which then shows up twice in the neighbors list and
      // confuses the LLM prompt.
      const exists = state.edges.some(
        (e) => e.source === conn.source && e.target === conn.target,
      );
      if (exists) return state;
      return { edges: addEdge({ ...conn, id: nextEdgeId() }, state.edges) };
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
      };
      return { nodes: [...state.nodes, node] };
    }),

  deleteSelected: () =>
    set((state) => {
      const selectedNodeIds = new Set(state.nodes.filter((n) => n.selected).map((n) => n.id));
      const selectedEdgeIds = new Set(state.edges.filter((e) => e.selected).map((e) => e.id));
      if (selectedNodeIds.size === 0 && selectedEdgeIds.size === 0) return state;
      return {
        nodes: state.nodes.filter((n) => !selectedNodeIds.has(n.id)),
        edges: state.edges.filter(
          (e) =>
            !selectedEdgeIds.has(e.id) &&
            !selectedNodeIds.has(e.source) &&
            !selectedNodeIds.has(e.target),
        ),
      };
    }),

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

    // Drop edges whose endpoints don't exist in the loaded node set and drop
    // self-loops — both are normally impossible but can creep in from hand-
    // edited save files or old versions of the schema.
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

    set({ nodes, edges });
  },

  reset: () => set({ nodes: [], edges: [] }),
}));
