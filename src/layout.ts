import type dagreNs from 'dagre';
import { Edge } from 'reactflow';
import { FBlockNode } from './store';

// Lazy-load dagre so its ~60kB gzipped bundle doesn't bloat the initial
// page load. The module is fetched once on first Layout click and cached
// for subsequent clicks.
let dagrePromise: Promise<typeof dagreNs> | null = null;
function loadDagre(): Promise<typeof dagreNs> {
  if (!dagrePromise) {
    dagrePromise = import('dagre').then((m) => m.default ?? m);
  }
  return dagrePromise;
}

/**
 * Compute a top-to-bottom auto-layout for the graph using dagre.
 * Returns a map of node id → new {x, y} position (top-left corner that
 * React Flow expects — we subtract half the node size from dagre's
 * center-based coords).
 */
export async function computeLayout(
  nodes: FBlockNode[],
  edges: Edge[],
): Promise<Record<string, { x: number; y: number }>> {
  const dagre = await loadDagre();

  const nodeWidth = 260;
  const nodeHeight = 160;

  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: 'LR', nodesep: 60, ranksep: 120, marginx: 40, marginy: 40 });

  for (const n of nodes) {
    g.setNode(n.id, { width: nodeWidth, height: nodeHeight });
  }
  for (const e of edges) {
    g.setEdge(e.source, e.target);
  }

  dagre.layout(g);

  const result: Record<string, { x: number; y: number }> = {};
  for (const n of nodes) {
    const pos = g.node(n.id);
    if (!pos) continue;
    result[n.id] = {
      x: pos.x - nodeWidth / 2,
      y: pos.y - nodeHeight / 2,
    };
  }
  return result;
}
