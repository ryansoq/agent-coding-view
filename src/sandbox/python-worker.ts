// Classic Web Worker that loads Pyodide from the jsdelivr CDN and runs
// user-provided Python function bodies against user-provided tests.
//
// Spawned without `{ type: 'module' }` so `importScripts()` works — which
// means we CANNOT put `export {}` here; classic scripts reject `export`
// at runtime. To keep TypeScript from treating top-level identifiers as
// globals (and colliding with worker.ts), we use a distinct prefix for
// this file's identifiers (`py*`) instead.
//
// The main thread treats this as a PERSISTENT worker — Pyodide takes
// several seconds to initialise, so we reuse the same worker across
// many runs. runner.ts correlates requests and responses by numeric id.

/* eslint-disable @typescript-eslint/no-explicit-any */
declare function importScripts(...urls: string[]): void;
declare const loadPyodide: (config?: { indexURL?: string }) => Promise<any>;

// Pinned version so the behaviour is reproducible. Bump intentionally.
const PYODIDE_VERSION = '0.26.4';
const PYODIDE_BASE = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

importScripts(PYODIDE_BASE + 'pyodide.js');

// Python-side test runtime. Mirrors the JS sandbox API (camelCase intentionally
// kept so users write the same assertions in both languages).
const PY_RUNTIME = `
import json

__results = []

def test(name, fn):
    try:
        fn()
        __results.append({'name': name, 'ok': True})
    except Exception as e:
        __results.append({'name': name, 'ok': False, 'error': f'{type(e).__name__}: {e}'})

def it(name, fn):
    return test(name, fn)

def _fmt(v):
    try:
        return json.dumps(v, default=str)
    except Exception:
        return repr(v)

class _Expect:
    def __init__(self, actual):
        self.actual = actual

    def toBe(self, expected):
        if self.actual != expected:
            raise AssertionError('expected ' + _fmt(expected) + ', got ' + _fmt(self.actual))

    def toEqual(self, expected):
        if self.actual != expected:
            raise AssertionError('expected ' + _fmt(expected) + ', got ' + _fmt(self.actual))

    def toThrow(self, msg=None):
        if not callable(self.actual):
            raise AssertionError('toThrow expected a callable — wrap the call in lambda: ...')
        try:
            self.actual()
        except Exception as e:
            if msg is not None and msg not in str(e):
                raise AssertionError('expected error to include ' + repr(msg) + ', got ' + repr(str(e)))
            return
        raise AssertionError('expected callable to raise')

    def toBeTruthy(self):
        if not self.actual:
            raise AssertionError('expected truthy, got ' + _fmt(self.actual))

    def toBeFalsy(self):
        if self.actual:
            raise AssertionError('expected falsy, got ' + _fmt(self.actual))

    def toBeCloseTo(self, expected, precision=2):
        if abs(self.actual - expected) > (10 ** -precision) / 2:
            raise AssertionError('expected ' + str(expected) + ' (+/- 10^-' + str(precision) + '), got ' + str(self.actual))

def expect(actual):
    return _Expect(actual)
`;

interface WorkerRequest {
  id: number;
  functionName: string;
  params: string[];
  body: string;
  tests: string;
}

let pyodidePromise: Promise<any> | null = null;

function getPyodide(): Promise<any> {
  if (!pyodidePromise) {
    pyodidePromise = loadPyodide({ indexURL: PYODIDE_BASE });
  }
  return pyodidePromise;
}

const pyCtx = self as unknown as {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage: (m: unknown) => void;
};

pyCtx.onmessage = async (e: MessageEvent) => {
  const { id, functionName, params, body, tests } = e.data as WorkerRequest;

  let pyodide: any;
  try {
    pyodide = await getPyodide();
  } catch (err) {
    pyCtx.postMessage({
      id,
      result: {
        status: 'error',
        error: 'Failed to load Pyodide: ' + ((err as Error)?.message || String(err)),
      },
    });
    return;
  }

  try {
    const paramList = params.join(', ');
    // Each line of the body needs 4 spaces of indentation to sit inside `def`.
    const indentedBody = body
      .split('\n')
      .map((line) => '    ' + line)
      .join('\n');
    const defBlock =
      `def ${functionName}(${paramList}):\n` +
      (indentedBody.trim() ? indentedBody : '    pass');

    const script =
      PY_RUNTIME +
      '\n\n' +
      defBlock +
      '\n\n' +
      tests +
      '\n\n' +
      '__results_json = json.dumps(__results)';

    await pyodide.runPythonAsync(script);
    const json = pyodide.globals.get('__results_json');
    const resultsStr = typeof json === 'string' ? json : String(json);
    const results = JSON.parse(resultsStr);
    pyCtx.postMessage({ id, result: { status: 'done', results } });
  } catch (err) {
    // Pyodide traceback lands here as a long multi-line string; the bottom few
    // lines are the actionable ones.
    const raw = err instanceof Error ? err.message : String(err);
    const lines = raw.split('\n').map((l) => l.trimEnd()).filter(Boolean);
    const short = lines.slice(-4).join('\n');
    pyCtx.postMessage({ id, result: { status: 'error', error: short } });
  }
};
