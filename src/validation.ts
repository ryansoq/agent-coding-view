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
}

/**
 * Read-only summary of the graph — counts of blocks, edges, per-language
 * and per-mode distribution, and aggregate test pass/fail. Surfaces in
 * the Issues modal header so you can see the shape of the graph at a
 * glance without counting cards.
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
  };
}
