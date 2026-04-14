import { useEffect, useMemo, useRef, useState } from 'react';
import { useGraphStore } from './store';
import { useSettingsStore } from './settingsStore';
import { DevMode, FunctionBlockData } from './types';
import { generateBody, generateBodyAsync } from './llm';
import { LANGUAGES, labelFor } from './languages';
import { runTests, isLanguageSandboxed, RunResult, RunHandle } from './sandbox/runner';

const MODES: DevMode[] = ['SDD', 'TDD', 'manual'];
const MAX_TDD_ITERATIONS = 5;
const ITERATION_INFO_CLEAR_MS = 4000;

/**
 * Read the live, up-to-date data for a block id directly from the store.
 * Closure-captured `d = selected.data` goes stale during long async flows
 * (streaming, Auto TDD), so hot paths should use this instead.
 */
function liveBlock(id: string): FunctionBlockData | null {
  return useGraphStore.getState().nodes.find((n) => n.id === id)?.data ?? null;
}

export function Inspector() {
  const nodes = useGraphStore((s) => s.nodes);
  const edges = useGraphStore((s) => s.edges);
  const patch = useGraphStore((s) => s.patchBlock);
  const appendBody = useGraphStore((s) => s.appendBlockBody);
  const resetBody = useGraphStore((s) => s.resetBlockBody);
  const deleteSelected = useGraphStore((s) => s.deleteSelected);

  const apiKey = useSettingsStore((s) => s.apiKey);
  const model = useSettingsStore((s) => s.model);
  const defaultLanguage = useSettingsStore((s) => s.language);
  const openSettings = useSettingsStore((s) => s.open);

  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<RunResult | null>(null);
  const [iterationInfo, setIterationInfo] = useState<string | null>(null);

  // Shared across Generate / Auto TDD / Run tests so Stop cleanly cancels whichever is in flight.
  const userAborted = useRef({ aborted: false });
  const genAbort = useRef<(() => void) | null>(null);
  const testHandle = useRef<RunHandle | null>(null);
  const iterationInfoTimer = useRef<number | null>(null);

  const selected = useMemo(() => nodes.find((n) => n.selected), [nodes]);

  const neighbors = useMemo(() => {
    if (!selected) return [];
    const byId = new Map(nodes.map((n) => [n.id, n.data]));
    const list: Array<{ name: string; signature: string; direction: 'upstream' | 'downstream' }> = [];
    for (const e of edges) {
      if (e.target === selected.id) {
        const up = byId.get(e.source);
        if (up) list.push({ name: up.name, signature: up.signature, direction: 'upstream' });
      }
      if (e.source === selected.id) {
        const dn = byId.get(e.target);
        if (dn) list.push({ name: dn.name, signature: dn.signature, direction: 'downstream' });
      }
    }
    return list;
  }, [selected, nodes, edges]);

  useEffect(() => {
    setLastResult(null);
    setError(null);
    setIterationInfo(null);
    if (iterationInfoTimer.current) {
      window.clearTimeout(iterationInfoTimer.current);
      iterationInfoTimer.current = null;
    }
  }, [selected?.id]);

  // Auto-clear the iteration info banner a few seconds after it lands in a terminal state.
  const flashIterationInfo = (msg: string) => {
    setIterationInfo(msg);
    if (iterationInfoTimer.current) window.clearTimeout(iterationInfoTimer.current);
    iterationInfoTimer.current = window.setTimeout(() => {
      setIterationInfo(null);
      iterationInfoTimer.current = null;
    }, ITERATION_INFO_CLEAR_MS);
  };

  const clearIterationInfoTimer = () => {
    if (iterationInfoTimer.current) {
      window.clearTimeout(iterationInfoTimer.current);
      iterationInfoTimer.current = null;
    }
  };

  if (!selected) {
    return (
      <aside className="inspector inspector--empty">
        <div className="inspector__empty">
          <div className="inspector__empty-title">No block selected</div>
          <div className="inspector__empty-hint">Click a block on the canvas to edit it.</div>
        </div>
      </aside>
    );
  }

  const d = selected.data;
  const isGenerating = d.status === 'generating';
  const isRunningTests = d.status === 'running_tests';
  const isBusy = isGenerating || isRunningTests;
  const effectiveLanguage = d.language || defaultLanguage;
  const canRunTests = isLanguageSandboxed(effectiveLanguage);

  const onGenerate = () => {
    setError(null);
    setLastResult(null);
    clearIterationInfoTimer();
    setIterationInfo(null);
    userAborted.current.aborted = false;
    patch(selected.id, { body: '', status: 'generating' });

    const handle = generateBody(
      apiKey,
      model,
      { block: d, neighbors, language: effectiveLanguage },
      {
        onDelta: (delta) => appendBody(selected.id, delta),
        onDone: ({ body }) => {
          patch(selected.id, { body, status: 'specd' });
          genAbort.current = null;
        },
        onError: (err) => {
          // The underlying stream swallows post-abort errors, but belt-and-suspenders:
          // if userAborted flipped between the stream firing and onError running, skip.
          if (userAborted.current.aborted) {
            patch(selected.id, { status: 'stub' });
            genAbort.current = null;
            return;
          }
          setError(err.message);
          patch(selected.id, { status: 'stub' });
          genAbort.current = null;
        },
      },
    );
    genAbort.current = handle.abort;
  };

  const onRunTests = async () => {
    const live = liveBlock(selected.id);
    if (!live) return;
    if (!live.body) { setError('Generate a body first.'); return; }
    if (!live.tests) { setError('Write some tests first.'); return; }
    setError(null);
    clearIterationInfoTimer();
    setIterationInfo(null);
    userAborted.current.aborted = false;
    patch(selected.id, { status: 'running_tests' });

    const run = runTests({
      language: effectiveLanguage,
      functionName: live.name,
      signature: live.signature,
      body: live.body,
      tests: live.tests,
    });
    testHandle.current = run;
    const result = await run.promise;
    testHandle.current = null;

    if (userAborted.current.aborted) {
      patch(selected.id, { status: 'specd' });
      setLastResult(null);
      return;
    }
    setLastResult(result);

    if (result.status === 'done') {
      const allOk = result.results.length > 0 && result.results.every((r) => r.ok);
      patch(selected.id, { status: allOk ? 'passing' : 'failing' });
    } else {
      patch(selected.id, { status: 'failing' });
    }
  };

  const onAutoTDD = async () => {
    const initial = liveBlock(selected.id);
    if (!initial) return;
    if (!initial.tests) { setError('Write some tests first.'); return; }
    if (!apiKey) { setError('Set your API key in Settings first.'); return; }
    setError(null);
    setLastResult(null);
    clearIterationInfoTimer();
    userAborted.current.aborted = false;

    let prevBody: string | null = null;
    let prevFailures: Array<{ name: string; error: string }> = [];

    for (let i = 0; i < MAX_TDD_ITERATIONS; i++) {
      if (userAborted.current.aborted) break;

      // Re-read each iteration so edits between rounds take effect.
      const live = liveBlock(selected.id);
      if (!live) return;

      setIterationInfo(`Auto TDD iteration ${i + 1}/${MAX_TDD_ITERATIONS} — generating…`);
      patch(selected.id, { body: '', status: 'generating' });

      let body: string;
      try {
        const gen = generateBodyAsync(
          apiKey,
          model,
          {
            block: live,
            neighbors,
            language: effectiveLanguage,
            previousAttempt: prevBody
              ? { body: prevBody, failures: prevFailures }
              : undefined,
          },
          (delta) => appendBody(selected.id, delta),
        );
        genAbort.current = gen.abort;
        body = await gen.promise;
        genAbort.current = null;
      } catch (err) {
        genAbort.current = null;
        if (userAborted.current.aborted) {
          patch(selected.id, { status: 'stub' });
          flashIterationInfo('Auto TDD aborted.');
          return;
        }
        setError(`Generation failed: ${(err as Error).message}`);
        patch(selected.id, { status: 'stub' });
        setIterationInfo(null);
        return;
      }

      if (userAborted.current.aborted) break;

      patch(selected.id, { body, status: 'running_tests' });
      setIterationInfo(`Auto TDD iteration ${i + 1}/${MAX_TDD_ITERATIONS} — running tests…`);

      const run = runTests({
        language: effectiveLanguage,
        functionName: live.name,
        signature: live.signature,
        body,
        tests: live.tests,
      });
      testHandle.current = run;
      const result = await run.promise;
      testHandle.current = null;

      if (userAborted.current.aborted) {
        resetBody(selected.id);
        patch(selected.id, { body, status: 'specd' });
        flashIterationInfo('Auto TDD aborted.');
        return;
      }
      setLastResult(result);

      if (result.status === 'done' && result.results.length > 0 && result.results.every((r) => r.ok)) {
        patch(selected.id, { status: 'passing' });
        flashIterationInfo(`Auto TDD passed on iteration ${i + 1}.`);
        return;
      }

      prevBody = body;
      prevFailures =
        result.status === 'done'
          ? result.results.filter((r) => !r.ok).map((r) => ({ name: r.name, error: r.error || 'unknown failure' }))
          : [{ name: '<runtime>', error: result.error }];
    }

    if (userAborted.current.aborted) {
      patch(selected.id, { status: 'stub' });
      flashIterationInfo('Auto TDD aborted.');
    } else {
      patch(selected.id, { status: 'failing' });
      setError(`Auto TDD reached ${MAX_TDD_ITERATIONS} iterations without passing.`);
      setIterationInfo(null);
    }
  };

  const onAbort = () => {
    userAborted.current.aborted = true;
    genAbort.current?.();
    genAbort.current = null;
    testHandle.current?.abort();
    testHandle.current = null;
    // Status is reset inside the respective catch/after-await branches, not here —
    // different paths have different "what to reset to" semantics.
  };

  return (
    <aside className="inspector">
      <div className="inspector__header">
        <span className="inspector__title">{d.name || 'untitled'}</span>
        <button className="icon-btn" onClick={openSettings} title="Settings">⚙</button>
      </div>

      <div className="inspector__body">
        <label className="field">
          <span className="field__label">Name</span>
          <input
            className="field__input"
            value={d.name}
            onChange={(e) => patch(selected.id, { name: e.target.value })}
            spellCheck={false}
          />
        </label>

        <label className="field">
          <span className="field__label">Language</span>
          <select
            className="field__input"
            value={d.language}
            onChange={(e) => patch(selected.id, { language: e.target.value })}
          >
            <option value="">Inherit global ({labelFor(defaultLanguage)})</option>
            {LANGUAGES.map((l) => (
              <option key={l.id} value={l.id}>{l.label}</option>
            ))}
          </select>
        </label>

        <label className="field">
          <span className="field__label">Signature</span>
          <input
            className="field__input field__input--mono"
            value={d.signature}
            onChange={(e) => patch(selected.id, { signature: e.target.value })}
            spellCheck={false}
          />
        </label>

        <div className="field">
          <span className="field__label">Development mode</span>
          <div className="segmented">
            {MODES.map((m) => (
              <button
                key={m}
                className={`segmented__btn ${d.mode === m ? 'active' : ''}`}
                onClick={() => patch(selected.id, { mode: m })}
              >
                {m}
              </button>
            ))}
          </div>
          <span className="field__hint">
            {d.mode === 'SDD' && 'Spec-driven — describe intent in English.'}
            {d.mode === 'TDD' && 'Test-driven — write tests the body must pass.'}
            {d.mode === 'manual' && 'Manual — free-form instructions.'}
          </span>
        </div>

        {d.mode === 'TDD' ? (
          <label className="field">
            <span className="field__label">Tests</span>
            <textarea
              className="field__input field__input--mono"
              rows={8}
              value={d.tests}
              onChange={(e) => patch(selected.id, { tests: e.target.value })}
              placeholder={`test('accepts valid', () => {\n  expect(${d.name}('x')).toBe('x');\n});`}
              spellCheck={false}
            />
            <span className="field__hint">
              Runtime provides <code>test()</code>, <code>expect()</code> with <code>toBe</code> / <code>toEqual</code> / <code>toThrow</code> / <code>toBeTruthy</code>.
            </span>
          </label>
        ) : (
          <label className="field">
            <span className="field__label">{d.mode === 'SDD' ? 'Spec' : 'Instructions'}</span>
            <textarea
              className="field__input"
              rows={6}
              value={d.spec}
              onChange={(e) => patch(selected.id, { spec: e.target.value })}
              placeholder={d.mode === 'SDD' ? 'Describe what this function does.' : 'Free-form instructions.'}
              spellCheck={false}
            />
          </label>
        )}

        <label className="field">
          <span className="field__label">Scope (file globs, one per line)</span>
          <textarea
            className="field__input field__input--mono"
            rows={3}
            value={d.scope.join('\n')}
            onChange={(e) =>
              patch(selected.id, {
                scope: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean),
              })
            }
            placeholder="src/feature/**/*.ts"
            spellCheck={false}
          />
        </label>

        <div className="field">
          <div className="field__row">
            <span className="field__label">Body</span>
            <div className="btn-group">
              {isBusy ? (
                <button className="primary" onClick={onAbort}>Stop</button>
              ) : (
                <>
                  <button className="primary" onClick={onGenerate}>
                    {d.body ? 'Regenerate' : 'Generate'}
                  </button>
                  {d.mode === 'TDD' && (
                    <>
                      <button
                        onClick={onRunTests}
                        disabled={!d.body || !d.tests || !canRunTests}
                        title={!canRunTests ? 'Sandbox supports JS/TS/Python only' : 'Run tests against current body'}
                      >
                        Run tests
                      </button>
                      <button
                        onClick={onAutoTDD}
                        disabled={!d.tests || !canRunTests}
                        title={!canRunTests ? 'Sandbox supports JS/TS/Python only' : 'Generate → test → iterate until green'}
                      >
                        Auto TDD
                      </button>
                    </>
                  )}
                </>
              )}
            </div>
          </div>
          <pre className={`body-view ${d.body ? '' : 'empty'}`}>
            {d.body || '// body not generated yet'}
            {isGenerating && <span className="cursor">▍</span>}
          </pre>
          {iterationInfo && <span className="field__hint">{iterationInfo}</span>}
          {d.mode === 'TDD' && effectiveLanguage === 'python' && isBusy && (
            <span className="field__hint">
              Running Python sandbox — first run downloads Pyodide (~10MB) and may take up to 15s.
            </span>
          )}
          {neighbors.length > 0 && (
            <span className="field__hint">
              Context: {neighbors.length} neighbor{neighbors.length > 1 ? 's' : ''} ({neighbors.map((n) => n.name).join(', ')})
            </span>
          )}
        </div>

        {lastResult && (
          <div className="test-results">
            <div className="test-results__header">
              Test results
              {lastResult.status === 'done' && (
                <span className="test-results__count">
                  {lastResult.results.filter((r) => r.ok).length}/{lastResult.results.length} passing
                </span>
              )}
            </div>
            {lastResult.status === 'error' ? (
              <div className="test-result fail">
                <div className="test-result__name">⚠ runtime error</div>
                <div className="test-result__error">{lastResult.error}</div>
              </div>
            ) : lastResult.results.length === 0 ? (
              <div className="test-result">
                <div className="test-result__name">No tests ran (check the Tests panel for syntax errors).</div>
              </div>
            ) : (
              lastResult.results.map((r, i) => (
                <div key={i} className={`test-result ${r.ok ? 'pass' : 'fail'}`}>
                  <div className="test-result__name">
                    <span className="test-result__icon">{r.ok ? '✓' : '✗'}</span>
                    {r.name}
                  </div>
                  {!r.ok && r.error && <div className="test-result__error">{r.error}</div>}
                </div>
              ))
            )}
          </div>
        )}

        {error && (
          <div className="error-banner">
            <strong>Error:</strong> {error}
            <button className="link-btn" onClick={() => setError(null)}>dismiss</button>
          </div>
        )}

        <div className="field">
          <button className="danger" onClick={deleteSelected}>Delete block</button>
        </div>
      </div>
    </aside>
  );
}
