export interface TestCase {
  name: string;
  ok: boolean;
  error?: string;
}

export type RunResult =
  | { status: 'done'; results: TestCase[] }
  | { status: 'error'; error: string };

export interface RunTestsInput {
  language: string;
  functionName: string;
  signature: string;
  body: string;
  tests: string;
  timeoutMs?: number;
}

export interface RunHandle {
  promise: Promise<RunResult>;
  abort: () => void;
}

const JS_LANGS = new Set(['typescript', 'javascript']);
const PY_LANGS = new Set(['python']);

const DEFAULT_JS_TIMEOUT = 5000;
// Pyodide cold-start alone is ~4-8s on first call; give it room. Subsequent
// calls complete in <200ms but we use the same cap for simplicity.
const DEFAULT_PY_TIMEOUT = 30000;

/**
 * Find the first balanced `(...)` in `s` and return the content between them.
 * Tracks string literals so parens inside `"hello("` don't confuse depth.
 * Returns null if no balanced pair is found.
 */
function matchBalancedParens(s: string): string | null {
  const openIdx = s.indexOf('(');
  if (openIdx < 0) return null;
  let depth = 1;
  let inString: false | string = false;
  let i = openIdx + 1;
  while (i < s.length && depth > 0) {
    const ch = s[i];
    if (inString) {
      if (ch === '\\' && i + 1 < s.length) { i += 2; continue; }
      if (ch === inString) inString = false;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch;
      i++;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return s.slice(openIdx + 1, i);
    }
    i++;
  }
  return null;
}

/**
 * Split a parameter list on top-level commas, respecting bracket depth
 * (() [] {} <>) and string literals. Returns the raw pieces (no trimming).
 */
function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let current = '';
  let paren = 0, bracket = 0, brace = 0, angle = 0;
  let inString: false | string = false;
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (inString) {
      current += ch;
      if (ch === '\\' && i + 1 < s.length) {
        current += s[i + 1];
        i += 2;
        continue;
      }
      if (ch === inString) inString = false;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch;
      current += ch;
      i++;
      continue;
    }
    if (ch === '(') paren++;
    else if (ch === ')') paren = Math.max(0, paren - 1);
    else if (ch === '[') bracket++;
    else if (ch === ']') bracket = Math.max(0, bracket - 1);
    else if (ch === '{') brace++;
    else if (ch === '}') brace = Math.max(0, brace - 1);
    else if (ch === '<') angle++;
    // `>` must only decrement if it plausibly closes a generic — otherwise it
    // ate an unmatched `=>` arrow or a comparison operator. Clamp to 0.
    else if (ch === '>' && angle > 0) angle--;

    if (ch === ',' && paren === 0 && bracket === 0 && brace === 0 && angle === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
    i++;
  }
  if (current.length > 0) parts.push(current);
  return parts;
}

export function extractParams(signature: string): string[] {
  const inside = matchBalancedParens(signature);
  if (inside === null) return [];
  const trimmed = inside.trim();
  if (!trimmed) return [];
  return splitTopLevel(trimmed)
    .map((p) => {
      p = p.trim();
      if (!p) return '';
      // For destructured params like `{a, b}` or `[x, y]`, treat the whole
      // pattern as the "name" and strip only a trailing type annotation.
      const isDestructured = p.startsWith('{') || p.startsWith('[');

      // Split at the first top-level `=` (default value).
      const eqIdx = findTopLevel(p, '=');
      const nameType = eqIdx === -1 ? p : p.slice(0, eqIdx);
      const defaultValue = eqIdx === -1 ? '' : p.slice(eqIdx + 1).trim();
      const def = defaultValue ? ` = ${defaultValue}` : '';

      if (isDestructured) {
        // Find the closing bracket of the pattern to strip the type.
        const end = matchClosingBracket(nameType);
        const pattern = end >= 0 ? nameType.slice(0, end + 1) : nameType;
        return pattern + def;
      }

      // Strip TS-style type annotation from the name side.
      const colonIdx = findTopLevel(nameType, ':');
      const name = (colonIdx === -1 ? nameType : nameType.slice(0, colonIdx)).trim();
      return name + def;
    })
    .filter(Boolean);
}

/**
 * Find the first occurrence of `needle` at top-level depth (depth-aware scan).
 * When searching for `=`, skips arrow (`=>`), equality (`==`, `===`), and
 * comparison (`!=`, `<=`, `>=`) tokens so only real assignments match.
 */
function findTopLevel(s: string, needle: string): number {
  let paren = 0, bracket = 0, brace = 0, angle = 0;
  let inString: false | string = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (ch === '\\') { i++; continue; }
      if (ch === inString) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inString = ch; continue; }
    if (ch === '(') paren++;
    else if (ch === ')') paren = Math.max(0, paren - 1);
    else if (ch === '[') bracket++;
    else if (ch === ']') bracket = Math.max(0, bracket - 1);
    else if (ch === '{') brace++;
    else if (ch === '}') brace = Math.max(0, brace - 1);
    else if (ch === '<') angle++;
    else if (ch === '>' && angle > 0) angle--;
    if (ch === needle && paren === 0 && bracket === 0 && brace === 0 && angle === 0) {
      if (needle === '=') {
        const next = s[i + 1];
        const prev = i > 0 ? s[i - 1] : '';
        // Skip `=>`, `==`, `!=`, `<=`, `>=`, `===`, and `!==`.
        if (next === '>' || next === '=') continue;
        if (prev === '!' || prev === '<' || prev === '>' || prev === '=') continue;
      }
      return i;
    }
  }
  return -1;
}

/** Given a string starting with `{` or `[`, return the index of its matching closer. */
function matchClosingBracket(s: string): number {
  const open = s[0];
  if (open !== '{' && open !== '[') return -1;
  const close = open === '{' ? '}' : ']';
  let depth = 1;
  for (let i = 1; i < s.length; i++) {
    const ch = s[i];
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

export function sanitizeName(name: string): string {
  const clean = name.replace(/[^A-Za-z0-9_$]/g, '_');
  if (!clean) return '_';
  return /^[0-9]/.test(clean) ? `_${clean}` : clean;
}

// ------------------------------------------------------------------
// JS sandbox — fresh worker per call, cheap to spawn
// ------------------------------------------------------------------

function runJsTests(input: RunTestsInput): RunHandle {
  const timeout = input.timeoutMs ?? DEFAULT_JS_TIMEOUT;
  const worker = new Worker(new URL('./worker.ts', import.meta.url), {
    type: 'module',
  });

  let settled = false;
  let resolveFn!: (r: RunResult) => void;
  const promise = new Promise<RunResult>((resolve) => {
    resolveFn = resolve;
  });

  const finish = (result: RunResult) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    worker.terminate();
    resolveFn(result);
  };

  const timer = setTimeout(() => {
    finish({
      status: 'error',
      error: `timeout: tests took more than ${timeout}ms (possible infinite loop)`,
    });
  }, timeout);

  worker.onmessage = (e) => finish(e.data as RunResult);
  worker.onerror = (e) => finish({ status: 'error', error: e.message || 'worker error' });

  worker.postMessage({
    functionName: sanitizeName(input.functionName),
    params: extractParams(input.signature),
    body: input.body,
    tests: input.tests,
  });

  return {
    promise,
    abort: () => finish({ status: 'error', error: 'aborted by user' }),
  };
}

// ------------------------------------------------------------------
// Python sandbox — persistent singleton worker (Pyodide is slow to init)
// ------------------------------------------------------------------

let pythonWorker: Worker | null = null;
let pythonMsgId = 0;
const pythonPending = new Map<number, (r: RunResult) => void>();

function getPythonWorker(): Worker {
  if (pythonWorker) return pythonWorker;
  // Classic worker (no { type: 'module' }) so importScripts() works inside.
  const w = new Worker(new URL('./python-worker.ts', import.meta.url));
  w.onmessage = (e: MessageEvent) => {
    const { id, result } = e.data as { id: number; result: RunResult };
    const resolver = pythonPending.get(id);
    if (resolver) {
      pythonPending.delete(id);
      resolver(result);
    }
  };
  w.onerror = (e: ErrorEvent) => {
    // Pyodide blew up (failed CDN fetch, initialisation crash, etc).
    // Reject anything in flight and drop the singleton so the next call retries.
    const err: RunResult = {
      status: 'error',
      error: `python worker error: ${e.message || 'unknown'}`,
    };
    for (const resolver of pythonPending.values()) resolver(err);
    pythonPending.clear();
    try { w.terminate(); } catch { /* noop */ }
    if (pythonWorker === w) pythonWorker = null;
  };
  pythonWorker = w;
  return w;
}

function resetPythonWorker(reason: string) {
  // Nuke the singleton and fail every pending request with the same reason.
  const err: RunResult = { status: 'error', error: reason };
  for (const resolver of pythonPending.values()) resolver(err);
  pythonPending.clear();
  if (pythonWorker) {
    try { pythonWorker.terminate(); } catch { /* noop */ }
    pythonWorker = null;
  }
}

function runPythonTests(input: RunTestsInput): RunHandle {
  const timeout = input.timeoutMs ?? DEFAULT_PY_TIMEOUT;
  const id = ++pythonMsgId;
  const worker = getPythonWorker();

  let settled = false;
  let resolveFn!: (r: RunResult) => void;
  const promise = new Promise<RunResult>((resolve) => {
    resolveFn = resolve;
  });

  const finish = (result: RunResult) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    pythonPending.delete(id);
    resolveFn(result);
  };

  pythonPending.set(id, finish);

  const timer = setTimeout(() => {
    // Python code in a worker is blocking, so termination is the only way
    // out of an infinite loop. Cost: Pyodide has to reload on the next call.
    resetPythonWorker(
      `timeout: python execution took more than ${timeout}ms (possible infinite loop — Pyodide will reload on next run)`,
    );
  }, timeout);

  worker.postMessage({
    id,
    functionName: sanitizeName(input.functionName),
    params: extractParams(input.signature),
    body: input.body,
    tests: input.tests,
  });

  return {
    promise,
    abort: () => {
      if (settled) return;
      resetPythonWorker('aborted by user (Pyodide will reload on next run)');
    },
  };
}

// ------------------------------------------------------------------
// Dispatcher
// ------------------------------------------------------------------

export function runTests(input: RunTestsInput): RunHandle {
  if (JS_LANGS.has(input.language)) return runJsTests(input);
  if (PY_LANGS.has(input.language)) return runPythonTests(input);
  return {
    promise: Promise.resolve({
      status: 'error',
      error: `no sandbox for language "${input.language}" — supported: typescript, javascript, python`,
    }),
    abort: () => {},
  };
}

export function isLanguageSandboxed(language: string): boolean {
  return JS_LANGS.has(language) || PY_LANGS.has(language);
}
