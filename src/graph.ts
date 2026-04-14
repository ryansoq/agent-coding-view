import { Edge } from 'reactflow';
import { FBlockNode } from './store';

/**
 * Find every node that participates in at least one cycle via DFS.
 * Self-loops are impossible (onConnect rejects them), but this still
 * handles them defensively for loaded graph files.
 *
 * Returns a Set of node IDs. Empty set means the graph is a DAG.
 */
export function detectCycles(nodes: FBlockNode[], edges: Edge[]): Set<string> {
  const adj = new Map<string, string[]>();
  for (const n of nodes) adj.set(n.id, []);
  for (const e of edges) {
    const list = adj.get(e.source);
    if (list && adj.has(e.target)) list.push(e.target);
  }

  const cycleMembers = new Set<string>();

  // Tarjan-style: track per-node state (unvisited / on-stack / done).
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const n of nodes) color.set(n.id, WHITE);

  // Iterative DFS so deep graphs don't blow the stack. Each frame records
  // the node and the next edge index to visit.
  const stack: Array<{ node: string; i: number; path: string[] }> = [];

  for (const start of nodes) {
    if (color.get(start.id) !== WHITE) continue;
    stack.push({ node: start.id, i: 0, path: [start.id] });
    color.set(start.id, GRAY);

    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const neighbors = adj.get(frame.node) ?? [];
      if (frame.i >= neighbors.length) {
        color.set(frame.node, BLACK);
        stack.pop();
        continue;
      }
      const next = neighbors[frame.i++];
      const nextColor = color.get(next) ?? WHITE;
      if (nextColor === WHITE) {
        color.set(next, GRAY);
        stack.push({ node: next, i: 0, path: [...frame.path, next] });
      } else if (nextColor === GRAY) {
        // Back-edge found — everything from `next` up through the current
        // path (inclusive) belongs to the cycle.
        const cycleStart = frame.path.indexOf(next);
        if (cycleStart >= 0) {
          for (let k = cycleStart; k < frame.path.length; k++) {
            cycleMembers.add(frame.path[k]);
          }
          cycleMembers.add(next);
        }
      }
      // BLACK → already explored, ignore
    }
  }

  return cycleMembers;
}
