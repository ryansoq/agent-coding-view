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
  return { nodes, edges: [] };
}
