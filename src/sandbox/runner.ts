export interface TestCase {
  name: string;
  ok: boolean;
  error?: string;
}

export type RunResult =
  | { status: 'done'; results: TestCase[] }
  | { status: 'error'; error: string };

export interface RunTestsInput {
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

export function runTests(input: RunTestsInput): RunHandle {
  const timeout = input.timeoutMs ?? 5000;
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
