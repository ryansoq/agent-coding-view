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

export function extractParams(signature: string): string[] {
  const match = signature.match(/\(([^)]*)\)/);
  if (!match) return [];
  const inside = match[1].trim();
  if (!inside) return [];
  return inside
    .split(',')
    .map((p) => {
      p = p.trim();
      if (!p) return '';
      const eqIdx = p.indexOf('=');
      const nameType = eqIdx === -1 ? p : p.slice(0, eqIdx);
      const def = eqIdx === -1 ? '' : ' ' + p.slice(eqIdx);
      const colonIdx = nameType.indexOf(':');
      const name = (colonIdx === -1 ? nameType : nameType.slice(0, colonIdx)).trim();
      return name + def;
    })
    .filter(Boolean);
}

export function sanitizeName(name: string): string {
  const clean = name.replace(/[^A-Za-z0-9_$]/g, '_');
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
