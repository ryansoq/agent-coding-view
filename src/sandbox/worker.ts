// Web Worker: receives { functionName, params, body, tests }, assembles a
// JavaScript script that wraps the body in `function name(params) { body }`,
// runs the user's tests against it using a minimal test/expect runtime, and
// posts back { status: 'done', results } or { status: 'error', error }.
//
// This file is a module worker (import below) so TypeScript keeps its top-
// level identifiers file-scoped — matters because python-worker.ts also
// declares a `ctx`.

import { JS_RUNTIME } from './jsRuntime';

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
      JS_RUNTIME + '\n' + userFn + '\n' + tests + '\nreturn __results;';

    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    const runner = new Function(script);
    const results = runner();
    ctx.postMessage({ status: 'done', results });
  } catch (err) {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    ctx.postMessage({ status: 'error', error: msg });
  }
};
