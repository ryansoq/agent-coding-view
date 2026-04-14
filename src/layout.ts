import dagre from 'dagre';
import { Edge } from 'reactflow';
import { FBlockNode } from './store';

/**
 * Compute a top-to-bottom auto-layout for the graph using dagre.
 * Returns a map of node id → new {x, y} position (top-left corner that
 * React Flow expects — we subtract half the node size from dagre's
 * center-based coords).
 */
export function computeLayout(
  nodes: FBlockNode[],
  edges: Edge[],
): Record<string, { x: number; y: number }> {
  // Our .fblock card is 260px wide; height varies with content but ~160 is a
  // reasonable average for layout purposes. Dagre uses these to compute spacing.
  const nodeWidth = 260;
  const nodeHeight = 160;

  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  // Left→right tends to read better for call-graph style diagrams.
  g.setGraph({ rankdir: 'LR', nodesep: 60, ranksep: 120, marginx: 40, marginy: 40 });

  for (const n of nodes) {
    g.setNode(n.id, { width: nodeWidth, height: nodeHeight });
  }
  for (const e of edges) {
    // Dagre silently ignores edges referencing unknown nodes, so no extra guard.
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
