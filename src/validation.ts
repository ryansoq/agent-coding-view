import { Edge } from 'reactflow';
import { FBlockNode } from './store';
import { detectCycles } from './graph';

export type IssueSeverity = 'error' | 'warning' | 'info';

export interface Issue {
  severity: IssueSeverity;
  message: string;
  /** Block this issue belongs to, if any. `undefined` means graph-level. */
  blockId?: string;
}

/**
 * Run every graph-level validation rule and return a flat list of issues.
 * Rules (ordered most → least severe):
 *  - error:   blocks with failing tests
 *  - warning: cycles, duplicate block names, TDD mode with no tests
 *  - info:    SDD mode with no spec, empty body on a stub
 */
export function validateGraph(nodes: FBlockNode[], edges: Edge[]): Issue[] {
  const issues: Issue[] = [];

  // --- errors ---

  for (const n of nodes) {
    if (n.data.status === 'failing') {
      issues.push({
        severity: 'error',
        blockId: n.id,
        message: `"${n.data.name}" has failing tests.`,
      });
    }
  }

  // --- warnings ---

  const cycleIds = detectCycles(nodes, edges);
  for (const id of cycleIds) {
    const name = nodes.find((n) => n.id === id)?.data.name ?? id;
    issues.push({
      severity: 'warning',
      blockId: id,
      message: `"${name}" is part of a cycle — upstream/downstream direction is ambiguous.`,
    });
  }

  const byName = new Map<string, FBlockNode[]>();
  for (const n of nodes) {
    const name = n.data.name;
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name)!.push(n);
  }
  for (const [name, group] of byName) {
    if (group.length > 1) {
      for (const g of group) {
        issues.push({
          severity: 'warning',
          blockId: g.id,
          message: `Duplicate name "${name}" — ${group.length} blocks share this name, neighbor context will be ambiguous.`,
        });
      }
    }
  }

  for (const n of nodes) {
    if (n.data.mode === 'TDD' && !n.data.tests.trim()) {
      issues.push({
        severity: 'warning',
        blockId: n.id,
        message: `"${n.data.name}" is TDD mode but has no tests written.`,
      });
    }
  }

  // Deliberately NOT flagging "SDD with no spec" or "stub with empty body":
  // brand-new blocks legitimately start in those states and flooding the
  // issues panel with info entries for them would train the user to ignore
  // it. We only surface states that actually need intervention.

  return issues;
}

export function countIssues(nodes: FBlockNode[], edges: Edge[]) {
  const all = validateGraph(nodes, edges);
  let errors = 0,
    warnings = 0,
    infos = 0;
  for (const i of all) {
    if (i.severity === 'error') errors++;
    else if (i.severity === 'warning') warnings++;
    else infos++;
  }
  return { errors, warnings, infos, total: all.length };
}

export interface GraphStats {
  blocks: number;
  edges: number;
  languages: Record<string, number>;
  modes: Record<string, number>;
  passing: number;
  failing: number;
  /**
   * Length of the longest call chain (number of blocks in the longest
   * dependency path). 0 for an empty graph, 1 for a graph with no edges
   * (every block is a chain of length 1). Cycles make this ill-defined;
   * nodes inside cycles contribute their topologically-reached depth.
   */
  longestChain: number;
  /**
   * Number of connected components in the graph, treating edges as
   * undirected. An isolated block counts as its own component.
   */
  components: number;
}

/**
 * Length of the longest dependency chain. Computes per-node "depth" via
 * Kahn-style topo iteration + DP — works for DAGs; nodes inside cycles
 * get whatever depth they accumulate before we hit a back-edge, which
 * is a harmless over-estimate for display purposes.
 */
function longestChainLength(nodes: FBlockNode[], edges: Edge[]): number {
  if (nodes.length === 0) return 0;
  const idSet = new Set(nodes.map((n) => n.id));
  const adj = new Map<string, string[]>();
  const inDegree = new Map<string, number>();
  for (const n of nodes) {
    adj.set(n.id, []);
    inDegree.set(n.id, 0);
  }
  for (const e of edges) {
    if (!idSet.has(e.source) || !idSet.has(e.target)) continue;
    adj.get(e.source)!.push(e.target);
    inDegree.set(e.target, (inDegree.get(e.target) || 0) + 1);
  }
  const depth = new Map<string, number>();
  for (const n of nodes) depth.set(n.id, 1);
  const queue: string[] = [];
  for (const n of nodes) if ((inDegree.get(n.id) || 0) === 0) queue.push(n.id);
  while (queue.length > 0) {
    const id = queue.shift()!;
    const d = depth.get(id) ?? 1;
    for (const next of adj.get(id) ?? []) {
      if ((depth.get(next) ?? 1) < d + 1) depth.set(next, d + 1);
      const ind = (inDegree.get(next) || 0) - 1;
      inDegree.set(next, ind);
      if (ind === 0) queue.push(next);
    }
  }
  let max = 0;
  for (const d of depth.values()) if (d > max) max = d;
  return max;
}

/** Count connected components, treating edges as undirected, via union-find. */
function connectedComponents(nodes: FBlockNode[], edges: Edge[]): number {
  const parent = new Map<string, string>();
  for (const n of nodes) parent.set(n.id, n.id);
  const find = (x: string): string => {
    let r = parent.get(x) ?? x;
    while (r !== (parent.get(r) ?? r)) {
      const next = parent.get(r) ?? r;
      r = next;
    }
    // Path compression
    let cur = x;
    while (parent.get(cur) !== r) {
      const p = parent.get(cur) ?? cur;
      parent.set(cur, r);
      cur = p;
    }
    return r;
  };
  for (const e of edges) {
    if (!parent.has(e.source) || !parent.has(e.target)) continue;
    const a = find(e.source);
    const b = find(e.target);
    if (a !== b) parent.set(a, b);
  }
  const roots = new Set<string>();
  for (const id of parent.keys()) roots.add(find(id));
  return roots.size;
}

/**
 * Read-only summary of the graph — counts of blocks, edges, per-language
 * and per-mode distribution, aggregate test pass/fail, longest chain
 * length, and connected component count. Surfaces in the Issues modal
 * header so you can see the shape of the graph at a glance without
 * counting cards.
 */
export function computeStats(nodes: FBlockNode[], edges: Edge[]): GraphStats {
  const languages: Record<string, number> = {};
  const modes: Record<string, number> = {};
  let passing = 0;
  let failing = 0;
  for (const n of nodes) {
    const lang = n.data.language || '(inherited)';
    languages[lang] = (languages[lang] ?? 0) + 1;
    modes[n.data.mode] = (modes[n.data.mode] ?? 0) + 1;
    if (n.data.status === 'passing') passing++;
    else if (n.data.status === 'failing') failing++;
  }
  return {
    blocks: nodes.length,
    edges: edges.length,
    languages,
    modes,
    passing,
    failing,
    longestChain: longestChainLength(nodes, edges),
    components: connectedComponents(nodes, edges),
  };
}
