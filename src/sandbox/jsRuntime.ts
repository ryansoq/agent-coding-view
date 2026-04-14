// JavaScript-side test runtime injected into the sandbox worker as a string
// prefix. Lives in its own module so unit tests can reuse the exact same
// source that ships in the worker, instead of re-implementing the runtime
// and drifting over time.

export const JS_RUNTIME = `
var __results = [];
var __logs = [];
// Replace the global console with a capturing shim. Uses var so the local
// binding shadows the worker's global console for the duration of this
// new Function() invocation.
var console = {
  log: function () {
    var parts = [];
    for (var i = 0; i < arguments.length; i++) {
      var a = arguments[i];
      try {
        parts.push(typeof a === 'string' ? a : JSON.stringify(a));
      } catch (_) {
        parts.push(String(a));
      }
    }
    __logs.push(parts.join(' '));
  },
};
console.warn = console.log;
console.error = console.log;
console.info = console.log;
function __deepEqual(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return a !== a && b !== b; // NaN
  // Special-case builtins whose equality isn't captured by own enumerable keys.
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  if (a instanceof RegExp || b instanceof RegExp) {
    return a instanceof RegExp && b instanceof RegExp && a.source === b.source && a.flags === b.flags;
  }
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
