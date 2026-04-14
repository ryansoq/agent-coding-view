// Web Worker: receives { functionName, params, body, tests }, assembles a
// JavaScript script that wraps the body in `function name(params) { body }`,
// runs the user's tests against it using a minimal test/expect runtime, and
// posts back { status: 'done', results } or { status: 'error', error }.

// This file is a module (export below) so TypeScript keeps its top-level
// identifiers in file scope instead of leaking them into the global namespace
// — matters because python-worker.ts also declares `ctx`.
export {};

const RUNTIME = `
var __results = [];
function __deepEqual(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return a !== a && b !== b; // NaN
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (!__deepEqual(a[i], b[i])) return false;
    return true;
  }
  var ak = Object.keys(a), bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (var j = 0; j < ak.length; j++) {
    var k = ak[j];
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!__deepEqual(a[k], b[k])) return false;
  }
  return true;
}
function test(name, fn) {
  try {
    fn();
    __results.push({ name: name, ok: true });
  } catch (e) {
    var msg = (e && e.message) ? e.message : String(e);
    __results.push({ name: name, ok: false, error: msg });
  }
}
function it(name, fn) { return test(name, fn); }
function expect(actual) {
  function fmt(v) {
    try { return JSON.stringify(v); } catch (_) { return String(v); }
  }
  return {
    toEqual: function (expected) {
      if (!__deepEqual(actual, expected))
        throw new Error('expected ' + fmt(expected) + ', got ' + fmt(actual));
    },
    toBe: function (expected) {
      if (actual !== expected)
        throw new Error('expected ' + fmt(expected) + ', got ' + fmt(actual));
    },
    toThrow: function (msg) {
      if (typeof actual !== 'function')
        throw new Error('toThrow expected a function — wrap the call in () => ...');
      var threw = false, err;
      try { actual(); } catch (e) { threw = true; err = e; }
      if (!threw) throw new Error('expected function to throw');
      if (msg) {
        var errStr = (err && err.message) ? err.message : String(err);
        if (errStr.indexOf(msg) < 0)
          throw new Error('expected error to include "' + msg + '", got "' + errStr + '"');
      }
    },
    toBeTruthy: function () {
      if (!actual) throw new Error('expected truthy, got ' + fmt(actual));
    },
    toBeFalsy: function () {
      if (actual) throw new Error('expected falsy, got ' + fmt(actual));
    },
    toBeCloseTo: function (expected, precision) {
      var p = (typeof precision === 'number') ? precision : 2;
      if (Math.abs(actual - expected) > Math.pow(10, -p) / 2)
        throw new Error('expected ' + expected + ' (± 10^-' + p + '), got ' + actual);
    },
  };
}
`;

interface WorkerInput {
  functionName: string;
  params: string[];
  body: string;
  tests: string;
}

interface WorkerSelf {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage: (m: unknown) => void;
}

const ctx = self as unknown as WorkerSelf;

ctx.onmessage = (e: MessageEvent) => {
  const { functionName, params, body, tests } = e.data as WorkerInput;

  try {
    const paramList = params.join(', ');
    const userFn = `function ${functionName}(${paramList}) {\n${body}\n}`;
    const script =
      RUNTIME + '\n' + userFn + '\n' + tests + '\nreturn __results;';

    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    const runner = new Function(script);
    const results = runner();
    ctx.postMessage({ status: 'done', results });
  } catch (err) {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    ctx.postMessage({ status: 'error', error: msg });
  }
};
