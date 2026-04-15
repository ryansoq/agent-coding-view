import { Edge } from 'reactflow';
import { FBlockNode } from './store';
import { defaultBlockData } from './types';

/**
 * Walk `code` from `i` past a balanced pair opened by `code[i]` (one of
 * `(`, `{`, `[`). Returns the index AFTER the closing character or -1 if
 * unmatched. Skips JS string literals and `//` and `/* * /` comments so
 * brackets inside them don't confuse depth.
 */
function skipBalanced(code: string, i: number): number {
  const open = code[i];
  const close = open === '(' ? ')' : open === '{' ? '}' : open === '[' ? ']' : '';
  if (!close) return -1;
  let depth = 1;
  let inString: false | string = false;
  i++;
  while (i < code.length && depth > 0) {
    const ch = code[i];
    if (inString) {
      if (ch === '\\' && i + 1 < code.length) { i += 2; continue; }
      if (ch === inString) inString = false;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inString = ch; i++; continue; }
    // Line comment
    if (ch === '/' && code[i + 1] === '/') {
      while (i < code.length && code[i] !== '\n') i++;
      continue;
    }
    // Block comment
    if (ch === '/' && code[i + 1] === '*') {
      i += 2;
      while (i < code.length - 1 && !(code[i] === '*' && code[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) depth--;
    i++;
  }
  return depth === 0 ? i : -1;
}

export interface ParsedFunction {
  name: string;
  params: string;
  body: string;
}

function isIdentChar(ch: string | undefined): boolean {
  return !!ch && /[a-zA-Z0-9_$]/.test(ch);
}

/**
 * Find every top-level `function NAME(...) { ... }` declaration in JS
 * source. Properly skips string literals and `//` and block comments at
 * the outer scan level (not just inside the body), so a "function foo"
 * mention inside a string or comment does NOT spuriously create a block.
 *
 * Arrow functions, class methods, and inner functions are deliberately
 * not surfaced by this MVP — only top-level `function name() {}`.
 */
export function findJsFunctions(source: string): ParsedFunction[] {
  const results: ParsedFunction[] = [];
  let i = 0;
  let inString: false | string = false;

  while (i < source.length) {
    const ch = source[i];

    if (inString) {
      if (ch === '\\' && i + 1 < source.length) { i += 2; continue; }
      if (ch === inString) inString = false;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch;
      i++;
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < source.length - 1 && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i += 2;
      continue;
    }

    // Match `function` as a whole token. `function*` (generator) is the
    // one place where the next char after `function` is allowed to be
    // a non-whitespace non-identifier char, so we can't simply require
    // `!isIdentChar(source[i + 8])` and bail.
    if (
      ch === 'f' &&
      source.slice(i, i + 8) === 'function' &&
      !isIdentChar(source[i - 1]) &&
      !isIdentChar(source[i + 8])
    ) {
      let j = i + 8;
      while (j < source.length && /\s/.test(source[j])) j++;
      // Skip optional `*` for generator functions.
      if (source[j] === '*') {
        j++;
        while (j < source.length && /\s/.test(source[j])) j++;
      }
      let name = '';
      while (j < source.length && isIdentChar(source[j])) {
        name += source[j];
        j++;
      }
      if (!name) { i++; continue; }
      while (j < source.length && /\s/.test(source[j])) j++;
      if (source[j] !== '(') { i++; continue; }
      const parenEnd = skipBalanced(source, j);
      if (parenEnd < 0) { i++; continue; }
      const params = source.slice(j + 1, parenEnd - 1).trim();
      let k = parenEnd;
      while (k < source.length && /\s/.test(source[k])) k++;
      if (source[k] !== '{') { i++; continue; }
      const bodyEnd = skipBalanced(source, k);
      if (bodyEnd < 0) { i++; continue; }
      const body = source.slice(k + 1, bodyEnd - 1).trim();
      results.push({ name, params, body });
      // Skip past the body so we don't re-scan its contents for nested
      // functions.
      i = bodyEnd;
      continue;
    }

    i++;
  }
  return results;
}

export interface ImportResult {
  nodes: FBlockNode[];
  edges: Edge[];
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Naive call-graph inference. For every block, scan its body for
 * `otherName(` patterns and add an edge `other → this` (other is
 * upstream because this block depends on it).
 *
 * String-literal and comment detection is deliberately skipped here —
 * a false positive on a word inside a comment is better than missing
 * a real call for MVP. Self-references (recursive calls) are ignored.
 */
export function inferCallEdges(nodes: FBlockNode[]): Edge[] {
  const edges: Edge[] = [];
  let n = 1;
  const seen = new Set<string>();
  for (const caller of nodes) {
    const body = caller.data.body;
    if (!body) continue;
    for (const callee of nodes) {
      if (callee.id === caller.id) continue;
      if (!callee.data.name) continue;
      const re = new RegExp(`\\b${escapeRegex(callee.data.name)}\\s*\\(`);
      if (!re.test(body)) continue;
      const key = `${callee.id}->${caller.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({
        id: `e${n++}`,
        source: callee.id,
        target: caller.id,
      });
    }
  }
  return edges;
}

/**
 * Build a graph from parsed JS source. One block per top-level function,
 * laid out in a column. No edges — call-graph reconstruction would need
 * semantic analysis to know which identifiers are calls vs variables, and
 * that's out of scope for the MVP.
 */
export function importJs(source: string, language = 'javascript'): ImportResult {
  const fns = findJsFunctions(source);
  const nodes: FBlockNode[] = fns.map((fn, i) => ({
    id: `b${i + 1}`,
    type: 'fblock',
    position: { x: 80, y: 80 + i * 220 },
    data: {
      ...defaultBlockData(fn.name),
      signature: `(${fn.params})`,
      body: fn.body,
      language,
      status: 'specd',
    },
  }));
  return { nodes, edges: inferCallEdges(nodes) };
}

/**
 * Find every TOP-LEVEL `def name(...):` declaration in Python source.
 * Uses a line-based scan with indent tracking: the body extends until the
 * first non-blank line whose indent is ≤ the def's indent. Indented defs
 * (class methods, nested) are intentionally not surfaced.
 *
 * Known limitation: `def foo():` inside a triple-quoted docstring would be
 * matched as a real declaration. This is rare enough in practice that MVP
 * accepts it — a proper Python parser (via Pyodide's ast module, or a JS-
 * side PEG) would be needed for full fidelity.
 */
export function findPyFunctions(source: string): ParsedFunction[] {
  const lines = source.split('\n');
  const results: ParsedFunction[] = [];
  // Allows `async def`, an optional `-> ReturnType`, and an optional
  // trailing `# comment`. The `:` must be the last meaningful thing on
  // the line — one-liner defs like `def foo(): return 1` are not
  // surfaced in this MVP.
  const defRe =
    /^(\s*)(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)\s*(?:->\s*[^:]+)?\s*:\s*(?:#.*)?$/;

  let i = 0;
  while (i < lines.length) {
    const m = lines[i].match(defRe);
    if (!m) { i++; continue; }
    const baseIndent = m[1].length;
    // MVP: only top-level defs. Indented defs (class methods, inner
    // defs) are left inside their containing function's body.
    if (baseIndent > 0) { i++; continue; }

    const name = m[2];
    const params = m[3].trim();

    // Collect body lines: blank or indented more than the def line.
    const bodyLines: string[] = [];
    let j = i + 1;
    while (j < lines.length) {
      const bl = lines[j];
      if (bl.trim() === '') {
        bodyLines.push(bl);
        j++;
        continue;
      }
      const indent = bl.match(/^[ \t]*/)?.[0].length ?? 0;
      if (indent <= baseIndent) break;
      bodyLines.push(bl);
      j++;
    }

    // Trim trailing blank lines and dedent by the minimum non-blank indent.
    while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1].trim() === '') {
      bodyLines.pop();
    }
    const indents = bodyLines
      .filter((l) => l.trim().length > 0)
      .map((l) => l.match(/^[ \t]*/)?.[0].length ?? 0);
    const minIndent = indents.length > 0 ? Math.min(...indents) : 0;
    const body = bodyLines.map((l) => l.slice(minIndent)).join('\n');

    results.push({ name, params, body });
    i = j;
  }
  return results;
}

/** Build a graph from parsed Python source. Mirror of importJs. */
export function importPy(source: string): ImportResult {
  const fns = findPyFunctions(source);
  const nodes: FBlockNode[] = fns.map((fn, i) => ({
    id: `b${i + 1}`,
    type: 'fblock',
    position: { x: 80, y: 80 + i * 220 },
    data: {
      ...defaultBlockData(fn.name),
      signature: `def ${fn.name}(${fn.params})`,
      body: fn.body,
      language: 'python',
      status: 'specd',
    },
  }));
  return { nodes, edges: inferCallEdges(nodes) };
}

/**
 * Pick an importer based on the file extension. Anything that's not
 * Python-ish falls through to the JS importer.
 */
export function importSource(source: string, filename: string): ImportResult {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.py')) return importPy(source);
  return importJs(source);
}
