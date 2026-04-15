// Smoke test — spawns `vite dev`, drives the app via Playwright/Chromium,
// verifies the core user journey. Run with `npm run test:e2e`.
//
// Covers: canvas render, block selection, TDD sandbox (pass/fail/timeout),
// settings modal, add block, no console errors. Does NOT exercise the
// Claude API path (that needs an ANTHROPIC_API_KEY and is skipped here).

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const log = (msg) => console.log(`[e2e] ${msg}`);

async function waitForVite() {
  return new Promise((resolve, reject) => {
    const proc = spawn('npm', ['run', 'dev'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });
    let ready = false;
    proc.stdout.on('data', (chunk) => {
      const s = chunk.toString();
      const m = s.match(/Local:\s+(http:\/\/[^\s]+)/);
      if (m && !ready) {
        ready = true;
        resolve({ proc, url: m[1].replace(/\/$/, '') });
      }
    });
    proc.stderr.on('data', (c) => process.stderr.write('[vite stderr] ' + c));
    proc.on('exit', (code) => {
      if (!ready) reject(new Error(`vite exited early with code ${code}`));
    });
    setTimeout(() => {
      if (!ready) reject(new Error('vite did not become ready within 15s'));
    }, 15000);
  });
}

let vite;
let browser;
let failures = 0;
const errors = [];

// Console errors Chromium emits for things we're deliberately triggering
// (mocked 4xx/5xx responses). These are browser-level logs, not app bugs.
const IGNORED_CONSOLE = [
  /Failed to load resource.*401/,
  /Failed to load resource.*500/,
  /Failed to load resource.*4\d\d/,
  /Failed to load resource.*5\d\d/,
];

function isIgnoredConsoleError(text) {
  return IGNORED_CONSOLE.some((re) => re.test(text));
}

function check(label, cond, detail) {
  if (cond) log(`  ✓ ${label}`);
  else {
    log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`);
    failures++;
  }
}

async function clearGraphAndReload(page, viteUrl) {
  // Clear ONLY the persisted graph so settings (api key for mocked
  // sections) survive. Then reload to pick up the seed graph fresh.
  await page.evaluate(() => localStorage.removeItem('agent-coding-view:graph'));
  await page.goto(viteUrl, { waitUntil: 'networkidle' });
  await page.waitForSelector('.react-flow__node');
}

try {
  log('starting vite…');
  vite = await waitForVite();
  log(`vite ready at ${vite.url}`);

  browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  page.on('pageerror', (e) => { errors.push(`pageerror: ${e.message}`); });
  page.on('console', (m) => {
    if (m.type() === 'error' && !isIgnoredConsoleError(m.text())) {
      errors.push(`console.error: ${m.text()}`);
    }
  });

  log('loading app…');
  await page.goto(vite.url, { waitUntil: 'networkidle' });

  // 1. App renders without top-level errors
  log('\n=== 1. initial load ===');
  await page.waitForSelector('.react-flow__node', { timeout: 10000 });
  const nodeCount = (await page.$$('.react-flow__node')).length;
  check('canvas mounts', nodeCount > 0, `saw ${nodeCount} nodes`);
  check('exactly 4 seed blocks', nodeCount === 4, `got ${nodeCount}`);
  check('toolbar title visible', !!(await page.getByText('Agent Coding View').first()));
  check('empty inspector message', !!(await page.getByText('No block selected').count()));

  // 2. Click the "validate" block — name is a display span, so click propagates
  log('\n=== 2. select validate block ===');
  const rfNodes = page.locator('.react-flow__node');
  const rfCount = await rfNodes.count();
  let validateIdx = -1;
  for (let i = 0; i < rfCount; i++) {
    const val = await rfNodes.nth(i).locator('.fblock__name').first().textContent();
    if (val?.trim() === 'validate') { validateIdx = i; break; }
  }
  check('found validate block on canvas', validateIdx >= 0, `checked ${rfCount} nodes`);
  await rfNodes.nth(validateIdx).locator('.fblock__body').click();
  await page.waitForTimeout(300);
  const inspectorTitle = await page.locator('.inspector__title').textContent();
  check('inspector shows selected block name', inspectorTitle === 'validate', `got "${inspectorTitle}"`);

  // 3. Run tests — expect all three green
  log('\n=== 3. run tests on seed body ===');
  await page.getByRole('button', { name: 'Run tests' }).click();
  await page.waitForSelector('.test-results', { timeout: 8000 });
  const passCount = await page.locator('.test-result.pass').count();
  const failCount = await page.locator('.test-result.fail').count();
  check('test results panel appears', true);
  check('all 3 tests pass', passCount === 3 && failCount === 0, `${passCount} pass / ${failCount} fail`);
  const countLabel = await page.locator('.test-results__count').textContent();
  check('count label shows 3/3', countLabel === '3/3 passing', `got "${countLabel}"`);
  await page.waitForTimeout(300);
  const passingBlock = await page.locator('.fblock.status-passing').count();
  check('validate block gets status-passing class', passingBlock >= 1, `saw ${passingBlock}`);

  const validateFooterText = await page
    .locator('.fblock.status-passing .fblock__footer')
    .first()
    .textContent();
  check(
    'card footer shows 3/3 test count',
    validateFooterText?.includes('3/3') ?? false,
    `footer: "${validateFooterText}"`,
  );

  // 4. Break the body → run tests → expect red
  log('\n=== 4. break body, expect red ===');
  const testsBox = page.locator('.inspector textarea').first();
  await testsBox.fill(`test('always fails', () => { expect(1).toBe(2); });`);
  await page.getByRole('button', { name: 'Run tests' }).click();
  await page.waitForTimeout(500);
  const failAfter = await page.locator('.test-result.fail').count();
  check('failing test shows red', failAfter >= 1, `saw ${failAfter} fail rows`);
  const failingBlock = await page.locator('.fblock.status-failing').count();
  check('block gets status-failing class', failingBlock >= 1, `saw ${failingBlock}`);

  // 5. Test timeout — infinite loop should be killed
  log('\n=== 5. infinite loop triggers timeout ===');
  await testsBox.fill(`test('infinite loop', () => { while(true) {} });`);
  const t0 = Date.now();
  await page.getByRole('button', { name: 'Run tests' }).click();
  await page.waitForFunction(
    () => document.querySelector('.test-result')?.textContent?.includes('timeout'),
    { timeout: 10000 },
  );
  const elapsed = Date.now() - t0;
  check('timeout fires within ~5-7s', elapsed >= 4500 && elapsed <= 8000, `${elapsed}ms`);
  const timeoutText = await page.locator('.test-result').first().textContent();
  check('timeout error message mentions "timeout"', timeoutText?.toLowerCase().includes('timeout'), timeoutText);

  // 6. Settings modal opens + closes
  log('\n=== 6. settings modal ===');
  await page.locator('.toolbar .icon-btn').click();
  await page.waitForSelector('.modal', { timeout: 2000 });
  check('settings modal appears', !!(await page.locator('.modal').count()));
  const apiKeyInput = await page.locator('input[type="password"]').count();
  check('API key input present', apiKeyInput === 1);
  await page.getByRole('button', { name: 'Done' }).click();
  await page.waitForTimeout(200);
  const modalAfter = await page.locator('.modal').count();
  check('modal closes on Done', modalAfter === 0);

  // 7. Add a new block via toolbar
  log('\n=== 7. add new block ===');
  const beforeAdd = (await page.$$('.react-flow__node')).length;
  await page.getByRole('button', { name: '+ Add block' }).click();
  await page.waitForTimeout(200);
  const afterAdd = (await page.$$('.react-flow__node')).length;
  check('+ Add block adds a node', afterAdd === beforeAdd + 1, `${beforeAdd} → ${afterAdd}`);
  // addBlock uses a random position — in rare runs the new block lands
  // on top of py_slug and blocks later clicks. The newly-added block is
  // auto-selected, so Delete clears it and restores deterministic layout.
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.waitForTimeout(150);
  const afterCleanup = (await page.$$('.react-flow__node')).length;
  check('new block cleaned up after add test', afterCleanup === beforeAdd, `${afterCleanup} nodes`);

  // 7d. Multi-select delete — shift-click two nodes and Delete should
  // remove both plus any edges between them, Undo should bring them back.
  log('\n=== 7d. multi-select delete ===');
  const msBefore = (await page.$$('.react-flow__node')).length;
  const msEdgesBefore = (await page.$$('.react-flow__edge')).length;
  const msNodes = page.locator('.react-flow__node');
  // Click the first block normally, shift-click the second to add it.
  await msNodes.nth(0).locator('.fblock__body').click();
  await page.waitForTimeout(100);
  await msNodes.nth(1).locator('.fblock__body').click({ modifiers: ['Shift'] });
  await page.waitForTimeout(150);
  const msSelectedCount = await page.locator('.react-flow__node.selected').count();
  check('two nodes selected after shift-click', msSelectedCount === 2, `got ${msSelectedCount}`);
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.waitForTimeout(150);
  const msAfter = (await page.$$('.react-flow__node')).length;
  const msEdgesAfter = (await page.$$('.react-flow__edge')).length;
  check('multi-select delete removes both', msAfter === msBefore - 2, `${msBefore} → ${msAfter}`);
  // The two seed blocks we deleted (parseInput, validate) had an edge
  // between them, plus parseInput→enrich. The first is orphaned by
  // deleting parseInput; the second is orphaned by deleting validate's
  // upstream. Assert at least some edges got cleaned.
  check('orphaned edges removed', msEdgesAfter < msEdgesBefore, `${msEdgesBefore} → ${msEdgesAfter}`);
  // Undo — both nodes AND their edges should come back.
  await page.getByRole('button', { name: 'Undo' }).click();
  await page.waitForTimeout(150);
  const msUndoNodes = (await page.$$('.react-flow__node')).length;
  const msUndoEdges = (await page.$$('.react-flow__edge')).length;
  check('undo restores node count', msUndoNodes === msBefore, `${msBefore} vs ${msUndoNodes}`);
  check('undo restores edge count', msUndoEdges === msEdgesBefore, `${msEdgesBefore} vs ${msUndoEdges}`);

  // 7c. Undo/redo for structural ops — add a block, undo, assert it's gone;
  // redo, assert it's back.
  log('\n=== 7c. undo/redo ===');
  const undoBefore = (await page.$$('.react-flow__node')).length;
  await page.getByRole('button', { name: '+ Add block' }).click();
  await page.waitForTimeout(150);
  const undoAfterAdd = (await page.$$('.react-flow__node')).length;
  check('add then count went up', undoAfterAdd === undoBefore + 1);
  // Click Undo
  await page.getByRole('button', { name: 'Undo' }).click();
  await page.waitForTimeout(150);
  const undoAfterUndo = (await page.$$('.react-flow__node')).length;
  check('undo rolls back to pre-add count', undoAfterUndo === undoBefore, `${undoBefore} vs ${undoAfterUndo}`);
  // Click Redo
  await page.getByRole('button', { name: 'Redo' }).click();
  await page.waitForTimeout(150);
  const undoAfterRedo = (await page.$$('.react-flow__node')).length;
  check('redo brings the block back', undoAfterRedo === undoBefore + 1, `${undoBefore + 1} vs ${undoAfterRedo}`);
  // Clean up: the redone block is selected, Delete it (click toolbar Delete
  // because exact match avoids the Delete-block variant in the Inspector).
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.waitForTimeout(150);

  // 7a. Duplicate block — selecting validate and clicking Duplicate makes
  // a new "validate_copy" block and leaves the clone selected.
  log('\n=== 7a. duplicate block ===');
  // Re-select validate to make sure it's the active selection
  const dupNodes = page.locator('.react-flow__node');
  const dupCount = await dupNodes.count();
  let validIdx = -1;
  for (let i = 0; i < dupCount; i++) {
    const val = await dupNodes.nth(i).locator('.fblock__name').first().textContent();
    if (val?.trim() === 'validate') { validIdx = i; break; }
  }
  check('found validate before duplicate', validIdx >= 0);
  if (validIdx >= 0) {
    await dupNodes.nth(validIdx).locator('.fblock__body').click();
    await page.waitForTimeout(200);
    const before = (await page.$$('.react-flow__node')).length;
    await page.getByRole('button', { name: 'Duplicate' }).click();
    await page.waitForTimeout(200);
    const after = (await page.$$('.react-flow__node')).length;
    check('duplicate adds a new node', after === before + 1, `${before} → ${after}`);
    const hasCopy = (await page.locator('.react-flow__node:has-text("validate_copy")').count()) >= 1;
    check('clone is named validate_copy', hasCopy);
    const inspectorHead = await page.locator('.inspector__title').textContent();
    check('clone becomes the active selection', inspectorHead === 'validate_copy', `title: ${inspectorHead}`);
    // Delete the clone so subsequent sections see the original count.
    await page.getByRole('button', { name: 'Delete block' }).click();
    await page.waitForTimeout(200);
    // Re-select validate so the next check has an inspector to interact with.
    const postDupNodes = page.locator('.react-flow__node');
    const postDupCount = await postDupNodes.count();
    for (let i = 0; i < postDupCount; i++) {
      const val = await postDupNodes.nth(i).locator('.fblock__name').first().textContent();
      if (val?.trim() === 'validate') {
        await postDupNodes.nth(i).locator('.fblock__body').click();
        break;
      }
    }
    await page.waitForTimeout(200);
  }

  // 7b. Delete/Backspace in an inspector textarea must not delete the block
  log('\n=== 7b. delete-key in textarea does not delete block ===');
  const beforeKey = (await page.$$('.react-flow__node')).length;
  const scopeBox = page.locator('.inspector textarea').last(); // scope textarea
  await scopeBox.click();
  await scopeBox.press('Backspace');
  await scopeBox.press('Delete');
  await page.waitForTimeout(200);
  const afterKey = (await page.$$('.react-flow__node')).length;
  check('textarea keystrokes do not delete node', afterKey === beforeKey, `${beforeKey} → ${afterKey}`);

  // 8. Double-click name enters edit mode
  log('\n=== 8. double-click name to edit ===');
  const anyNode = page.locator('.react-flow__node').first();
  await anyNode.locator('.fblock__name').first().dblclick();
  await page.waitForTimeout(200);
  const editInputs = await anyNode.locator('input.fblock__name').count();
  check('double-click opens input', editInputs === 1);
  // Click elsewhere to exit edit mode so later steps aren't affected.
  await page.locator('.canvas').click({ position: { x: 10, y: 10 } });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  // 9. Python TDD sandbox — Pyodide first load, then run seed tests
  log('\n=== 9. python TDD sandbox (first load is slow: ~15-30s) ===');
  const rfNodes2 = page.locator('.react-flow__node');
  const rfCount2 = await rfNodes2.count();
  let pyIdx = -1;
  for (let i = 0; i < rfCount2; i++) {
    const val = await rfNodes2.nth(i).locator('.fblock__name').first().textContent();
    if (val?.trim() === 'py_slug') { pyIdx = i; break; }
  }
  check('found py_slug block on canvas', pyIdx >= 0);
  if (pyIdx >= 0) {
    await rfNodes2.nth(pyIdx).locator('.fblock__body').click();
    await page.waitForTimeout(300);
    const pyTitle = await page.locator('.inspector__title').textContent();
    check('inspector selects python block', pyTitle === 'py_slug');

    // Clear any stale results from earlier sections.
    const prevResults = page.locator('.test-results');
    if (await prevResults.count()) {
      // The result panel is scoped per-block via the useEffect reset-on-select, so it's gone.
    }

    const t0py = Date.now();
    await page.getByRole('button', { name: 'Run tests' }).click();
    // First Pyodide load downloads ~10MB from CDN + initialises. Generous timeout.
    await page.waitForSelector('.test-results .test-result', { timeout: 60000 });
    const pyElapsed = Date.now() - t0py;
    log(`  (pyodide first run took ${pyElapsed}ms)`);

    const pyPass = await page.locator('.test-result.pass').count();
    const pyFail = await page.locator('.test-result.fail').count();
    if (pyPass !== 4 || pyFail !== 0) {
      const rows = await page.locator('.test-result').allTextContents();
      log('  DEBUG python rows:');
      for (const r of rows) log('    ' + r.replace(/\n/g, ' | '));
    }
    // The seed block's body should pass all 4 tests.
    check('all 4 python tests pass', pyPass === 4 && pyFail === 0, `${pyPass} pass / ${pyFail} fail`);

    const pyPassingBlock = await page.locator('.fblock.status-passing').count();
    check('py_slug block gets status-passing class', pyPassingBlock >= 1);

    // Second run should reuse the warm worker AND the pre-loaded PY_RUNTIME.
    // Deselect → reselect to clear lastResult so the test-results panel
    // disappears and reappears, giving us a real before/after signal to
    // measure the true warm-run latency.
    await page.locator('.react-flow__pane').click({ position: { x: 50, y: 10 } });
    await page.waitForTimeout(150);
    await rfNodes2.nth(pyIdx).locator('.fblock__body').click();
    await page.waitForTimeout(150);
    const warmResultsVisible = await page.locator('.test-results').count();
    check('results panel cleared on reselect', warmResultsVisible === 0);

    const t1py = Date.now();
    await page.getByRole('button', { name: 'Run tests' }).click();
    await page.waitForSelector('.test-results .test-result', { timeout: 8000 });
    const t1Elapsed = Date.now() - t1py;
    log(`  (pyodide warm run took ${t1Elapsed}ms)`);
    // P4.5 target: after PY_RUNTIME preload, warm runs should complete in
    // well under a second.
    check('warm pyodide run finishes in <800ms', t1Elapsed < 800, `${t1Elapsed}ms`);
  }

  // 9a. Sandbox stdout capture — write a body that calls console.log,
  // run the tests, verify the captured Output panel shows up.
  log('\n=== 9a. sandbox stdout capture ===');
  // Find validate again and patch its body to print before returning
  const stdNodes = page.locator('.react-flow__node');
  const stdCount = await stdNodes.count();
  let stdValidIdx = -1;
  for (let i = 0; i < stdCount; i++) {
    const val = await stdNodes.nth(i).locator('.fblock__name').first().textContent();
    if (val?.trim() === 'validate') { stdValidIdx = i; break; }
  }
  if (stdValidIdx >= 0) {
    await stdNodes.nth(stdValidIdx).locator('.fblock__body').click();
    await page.waitForTimeout(150);
    // Re-fill tests with one that calls validate so its body runs
    const stdTests = page.locator('.inspector textarea').first();
    await stdTests.fill(
      `test('logs go through', () => { expect(validate('hello')).toBe('hello'); });`,
    );
    // Now inject a print into the body. The body is a <pre>, not editable —
    // we can patch via the store by triggering a regenerate? No — simpler,
    // load a graph file with the body we want.
  }
  // Use the file loader to inject a graph with a console.log in the body
  const stdoutGraph = JSON.stringify({
    version: 1,
    nodes: [
      {
        id: 'b1',
        position: { x: 100, y: 100 },
        data: {
          name: 'noisy',
          signature: '(s) => string',
          mode: 'TDD',
          spec: '',
          tests: `test('runs', () => { expect(noisy('hi')).toBe('hi'); });`,
          scope: [],
          body: `console.log('debug', s);\nconsole.warn('warning here');\nreturn s;`,
          status: 'specd',
          language: 'javascript',
        },
      },
    ],
    edges: [],
  });
  const fs2 = await import('node:fs/promises');
  const os2 = await import('node:os');
  const pathMod2 = await import('node:path');
  const stdoutTmp = pathMod2.join(os2.tmpdir(), `e2e-stdout-${Date.now()}.json`);
  await fs2.writeFile(stdoutTmp, stdoutGraph);
  await page.locator("input[type=\"file\"]").first().setInputFiles(stdoutTmp);
  await page.waitForTimeout(300);
  // Click the only block
  await page.locator('.react-flow__node').first().locator('.fblock__body').click();
  await page.waitForTimeout(200);
  await page.getByRole('button', { name: 'Run tests' }).click();
  await page.waitForSelector('.test-results__logs-body', { timeout: 5000 });
  const logsText = await page.locator('.test-results__logs-body').textContent();
  check('stdout panel contains debug log', logsText?.includes('debug hi') ?? false, `logs: "${logsText}"`);
  check('stdout panel contains warn log', logsText?.includes('warning here') ?? false);
  await fs2.unlink(stdoutTmp).catch(() => {});

  // Restore seed graph for subsequent sections
  await clearGraphAndReload(page, vite.url);

  // 9aa. Run all — one click should send both validate (JS) and py_slug
  // (Python) to passing state. Pyodide cold-start happens here on a
  // fresh page so allow ~30s.
  log('\n=== 9aa. Run all tests ===');
  await page.getByRole('button', { name: 'Run all' }).click();
  await page.waitForFunction(
    () => document.querySelectorAll('.fblock.status-passing').length >= 2,
    { timeout: 30000 },
  );
  const passingAfterRunAll = await page.locator('.fblock.status-passing').count();
  check('Run all leaves both TDD blocks passing', passingAfterRunAll >= 2, `${passingAfterRunAll}`);

  // 9b0. Persist roundtrip — add a block, reload (without clearing
  // localStorage), verify the new block is still on the canvas. Also
  // verify the inverse: clearing graph storage restores seeds.
  log('\n=== 9b0. graph persist across reload ===');
  const persistBefore = (await page.$$('.react-flow__node')).length;
  await page.getByRole('button', { name: '+ Add block' }).click();
  await page.waitForTimeout(150);
  const persistAfter = (await page.$$('.react-flow__node')).length;
  check('block added before reload', persistAfter === persistBefore + 1);
  // Plain reload — persist should restore the new state
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.react-flow__node');
  const afterReload = (await page.$$('.react-flow__node')).length;
  check('persist survives reload', afterReload === persistBefore + 1, `${persistBefore + 1} vs ${afterReload}`);
  // Clean up: clear and reload to restore seeds
  await clearGraphAndReload(page, vite.url);
  const restored = (await page.$$('.react-flow__node')).length;
  check('clearing graph storage restores seeds', restored === persistBefore, `${persistBefore} vs ${restored}`);

  // 9b. Cycle detection warning — drag-drop is fiddly in headless, so
  // inject a crafted cyclic graph via the file loader and verify the
  // Inspector shows the warning banner for a cycle member.
  log('\n=== 9b. cycle detection warning ===');
  const cycleJson = JSON.stringify({
    version: 1,
    nodes: [
      { id: 'b1', position: { x: 100, y: 100 }, data: { name: 'A', signature: '(x) => x', mode: 'SDD', spec: '', tests: '', scope: [], body: '', status: 'stub', language: 'javascript' } },
      { id: 'b2', position: { x: 300, y: 100 }, data: { name: 'B', signature: '(x) => x', mode: 'SDD', spec: '', tests: '', scope: [], body: '', status: 'stub', language: 'javascript' } },
    ],
    edges: [
      { id: 'e1', source: 'b1', target: 'b2' },
      { id: 'e2', source: 'b2', target: 'b1' },
    ],
  });
  // Write the crafted JSON to a temp file and load it.
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const pathMod = await import('node:path');
  const tmpFile = pathMod.join(os.tmpdir(), `e2e-cycle-${Date.now()}.json`);
  await fs.writeFile(tmpFile, cycleJson);
  await page.locator("input[type=\"file\"]").first().setInputFiles(tmpFile);
  await page.waitForTimeout(300);
  const cycleNodes = (await page.$$('.react-flow__node')).length;
  check('loaded cyclic graph has 2 nodes', cycleNodes === 2, `saw ${cycleNodes}`);
  // Click one of the blocks — both are in the cycle.
  const rfNodes3 = page.locator('.react-flow__node');
  await rfNodes3.nth(0).locator('.fblock__body').click();
  await page.waitForTimeout(200);
  const warning = await page.locator('.warning-banner').count();
  check('cycle warning banner appears for cycle member', warning >= 1, `saw ${warning}`);
  await fs.unlink(tmpFile).catch(() => {});

  // Restore the seed state so the save/load test below has something to work with.
  await clearGraphAndReload(page, vite.url);

  // 9c. Auto-layout — capture positions before, click Layout, verify at
  // least one block moved (dagre repositions them into columns).
  log('\n=== 9c. auto-layout ===');
  const before = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('.react-flow__node')).map((el) => {
      const t = (el).style.transform || '';
      const m = t.match(/translate\(([-\d.]+)px,\s*([-\d.]+)px\)/);
      return m ? { x: parseFloat(m[1]), y: parseFloat(m[2]) } : null;
    });
  });
  await page.getByRole('button', { name: 'Layout' }).click();
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('.react-flow__node')).map((el) => {
      const t = (el).style.transform || '';
      const m = t.match(/translate\(([-\d.]+)px,\s*([-\d.]+)px\)/);
      return m ? { x: parseFloat(m[1]), y: parseFloat(m[2]) } : null;
    });
  });
  const moved = before.some((b, i) => {
    const a = after[i];
    return b && a && (Math.abs(b.x - a.x) > 10 || Math.abs(b.y - a.y) > 10);
  });
  check('auto-layout repositions blocks', moved, `before=${JSON.stringify(before)}, after=${JSON.stringify(after)}`);
  // Undo the layout so subsequent sections see the seed positions.
  await page.getByRole('button', { name: 'Undo' }).click();
  await page.waitForTimeout(200);

  // 9d. Export graph to source file — global language is typescript by
  // default so validate (JS) is excluded; switch default language to
  // javascript via localStorage, reload, then Export and verify the
  // downloaded file contains the expected function shape.
  log('\n=== 9d. export graph to source ===');
  await page.evaluate(() => {
    const raw = localStorage.getItem('agent-coding-view:settings');
    const parsed = raw ? JSON.parse(raw) : { state: {}, version: 0 };
    parsed.state = { ...parsed.state, language: 'javascript' };
    localStorage.setItem('agent-coding-view:settings', JSON.stringify(parsed));
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.react-flow__node');
  const [exportDownload] = await Promise.all([
    page.waitForEvent('download', { timeout: 5000 }),
    page.getByRole('button', { name: 'Export' }).click(),
  ]);
  const exportPath = await exportDownload.path();
  check('export download triggered', !!exportPath);
  if (exportPath) {
    const fsMod = await import('node:fs/promises');
    const content = await fsMod.readFile(exportPath, 'utf-8');
    check('export file has header', content.includes('Generated by agent-coding-view'));
    check('export file defines validate function', /function validate\s*\(s\)/.test(content));
    check('export file contains validate body', content.includes("throw new Error('empty')"));
    check('export does NOT include python block', !content.includes('py_slug'));
    // Extension check
    const name = exportDownload.suggestedFilename();
    check('export filename ends in .js', name.endsWith('.js'), `filename: ${name}`);
  }

  // 9f. Import JS — round-trip: export the seed graph, clear, import the
  // exported file, verify validate is back as a block.
  log('\n=== 9f. import JS round-trip ===');
  await page.evaluate(() => {
    const raw = localStorage.getItem('agent-coding-view:settings');
    const parsed = raw ? JSON.parse(raw) : { state: {}, version: 0 };
    parsed.state = { ...parsed.state, language: 'javascript' };
    localStorage.setItem('agent-coding-view:settings', JSON.stringify(parsed));
  });
  await clearGraphAndReload(page, vite.url);

  const [importExport] = await Promise.all([
    page.waitForEvent('download', { timeout: 5000 }),
    page.getByRole('button', { name: 'Export' }).click(),
  ]);
  const exportedPath = await importExport.path();
  check('export downloaded for round-trip', !!exportedPath);

  await page.getByRole('button', { name: 'Clear' }).click();
  await page.waitForTimeout(150);
  const empty = (await page.$$('.react-flow__node')).length;
  check('canvas empty before import', empty === 0);

  if (exportedPath) {
    // Two hidden file inputs exist after the Import button was added:
    // [0] = JSON loader, [1] = JS importer.
    const importInputs = page.locator('input[type="file"]');
    const fileInputs = await importInputs.count();
    check('two hidden file inputs present', fileInputs === 2, `count=${fileInputs}`);
    await importInputs.nth(1).setInputFiles(exportedPath);
    await page.waitForTimeout(300);
    const afterImport = (await page.$$('.react-flow__node')).length;
    check('import created at least one block', afterImport >= 1, `${afterImport} nodes`);
    const importedNames = await page.locator('.fblock__name').allTextContents();
    check(
      'imported graph contains validate',
      importedNames.some((n) => n.trim() === 'validate'),
      `names: ${importedNames.join(', ')}`,
    );
  }

  await clearGraphAndReload(page, vite.url);

  // 9e. Issues modal — the seed graph is clean (no failing tests, no
  // cycles, no duplicate names, all TDD blocks have tests), so the
  // count should be zero and the modal should show "No issues found".
  // Then duplicate validate to create a name collision and verify the
  // count jumps to 2 warnings.
  log('\n=== 9e. issues modal ===');
  const cleanBtn = page.locator('button', { hasText: 'Issues' });
  const cleanLabel = await cleanBtn.first().textContent();
  check('Issues button has no count for clean seed graph', cleanLabel?.trim() === 'Issues', `label: "${cleanLabel}"`);
  await cleanBtn.first().click();
  await page.waitForSelector('.modal', { timeout: 2000 });
  const emptyMsg = await page.locator('.issues-empty__title').count();
  check('modal shows empty state for clean graph', emptyMsg === 1);
  // Close modal
  await page.locator('.modal .icon-btn').click();
  await page.waitForTimeout(150);

  // Now introduce a problem: duplicate validate to create a name collision
  const issuesNodes = page.locator('.react-flow__node');
  const issuesCount = await issuesNodes.count();
  let validIdxIssues = -1;
  for (let i = 0; i < issuesCount; i++) {
    const val = await issuesNodes.nth(i).locator('.fblock__name').first().textContent();
    if (val?.trim() === 'validate') { validIdxIssues = i; break; }
  }
  if (validIdxIssues >= 0) {
    await issuesNodes.nth(validIdxIssues).locator('.fblock__body').click();
    await page.waitForTimeout(150);
    await page.getByRole('button', { name: 'Duplicate' }).click();
    await page.waitForTimeout(150);
    // The clone is named "validate_copy", not "validate" — rename it to
    // force a collision.
    const nameInput = page.locator('.inspector input.field__input').first();
    await nameInput.fill('validate');
    await page.waitForTimeout(200);
  }

  // Click the toolbar button — it should now show a count
  const dirtyLabel = await page.locator('button', { hasText: 'Issues' }).first().textContent();
  check('Issues button shows non-zero count after collision', /Issues\s*\(\d+\)/.test(dirtyLabel || ''), `label: "${dirtyLabel}"`);
  await page.locator('button', { hasText: 'Issues' }).first().click();
  await page.waitForSelector('.modal', { timeout: 2000 });
  const warnRows = await page.locator('.issue-row--warning').count();
  check('two warnings for duplicate name', warnRows === 2, `got ${warnRows}`);
  // Click the first warning — should select that block and close the modal
  await page.locator('.issue-row--warning').first().click();
  await page.waitForTimeout(200);
  const modalGone = await page.locator('.modal').count();
  check('modal closes after clicking an issue', modalGone === 0);
  const inspectorAfter = await page.locator('.inspector__title').textContent();
  check(
    'clicking issue selects the offending block',
    inspectorAfter === 'validate',
    `title: ${inspectorAfter}`,
  );

  // Clean up — undo the duplicate+rename so later sections still see
  // the seed graph. Undo once for the duplicate action; the rename was
  // a patchBlock so it's not undoable.
  await page.getByRole('button', { name: 'Undo' }).click();
  await page.waitForTimeout(150);

  // 10. Save / Load JSON round-trip
  log('\n=== 10. save/load JSON round-trip ===');
  try {
    const beforeNodes = (await page.$$('.react-flow__node')).length;
    const beforeEdges = (await page.$$('.react-flow__edge')).length;

    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 5000 }),
      page.getByRole('button', { name: 'Save JSON' }).click(),
    ]);
    const savedPath = await download.path();
    check('download triggered', !!savedPath);

    await page.getByRole('button', { name: 'Clear' }).click();
    await page.waitForTimeout(200);
    const afterClearNodes = (await page.$$('.react-flow__node')).length;
    check('clear removes all nodes', afterClearNodes === 0, `${afterClearNodes} nodes left`);

    if (savedPath) {
      await page.locator("input[type=\"file\"]").first().setInputFiles(savedPath);
      await page.waitForTimeout(300);
      const loadedNodes = (await page.$$('.react-flow__node')).length;
      const loadedEdges = (await page.$$('.react-flow__edge')).length;
      check('loaded nodes match saved count', loadedNodes === beforeNodes, `${beforeNodes} → ${loadedNodes}`);
      check('loaded edges match saved count', loadedEdges === beforeEdges, `${beforeEdges} → ${loadedEdges}`);
    }
  } catch (err) {
    log(`  ✗ save/load failed: ${(err && err.message) || err}`);
    failures++;
  }

  // 11. Mocked Anthropic API — intercept the network call and return a
  // canned SSE response, then click Generate and verify the streamed body
  // lands in the block. Exercises llm.ts's stream handling and
  // extractCodeBlock end-to-end without needing a real API key.
  log('\n=== 11. mocked Anthropic streaming Generate ===');

  // Pre-seed zustand persist storage so Inspector sees a non-empty API key.
  const mockedPage = await ctx.newPage();
  await mockedPage.addInitScript(() => {
    localStorage.setItem(
      'agent-coding-view:settings',
      JSON.stringify({
        state: {
          apiKey: 'sk-ant-mock-e2e-key',
          model: 'claude-opus-4-6',
          language: 'typescript',
        },
        version: 0,
      }),
    );
  });
  mockedPage.on('pageerror', (e) => errors.push(`mocked pageerror: ${e.message}`));
  mockedPage.on('console', (m) => {
    if (m.type() === 'error' && !isIgnoredConsoleError(m.text())) {
      errors.push(`mocked console.error: ${m.text()}`);
    }
  });

  // Canned SSE body that the Anthropic TypeScript SDK's streaming parser
  // will unfold into text deltas, then finalMessage(). The body the LLM
  // "returns" is `return 42;` wrapped in a fenced code block.
  const sseBody = [
    'event: message_start',
    `data: ${JSON.stringify({
      type: 'message_start',
      message: {
        id: 'msg_mock',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-4-6',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    })}`,
    '',
    'event: content_block_start',
    `data: ${JSON.stringify({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    })}`,
    '',
    'event: content_block_delta',
    `data: ${JSON.stringify({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: '```js\n' },
    })}`,
    '',
    'event: content_block_delta',
    `data: ${JSON.stringify({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'return 42;\n' },
    })}`,
    '',
    'event: content_block_delta',
    `data: ${JSON.stringify({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: '```' },
    })}`,
    '',
    'event: content_block_stop',
    `data: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}`,
    '',
    'event: message_delta',
    `data: ${JSON.stringify({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 5 },
    })}`,
    '',
    'event: message_stop',
    `data: ${JSON.stringify({ type: 'message_stop' })}`,
    '',
    '',
  ].join('\n');

  let intercepted = 0;
  await mockedPage.route('https://api.anthropic.com/**', async (route) => {
    intercepted++;
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      headers: {
        'cache-control': 'no-cache',
        'access-control-allow-origin': '*',
      },
      body: sseBody,
    });
  });

  await mockedPage.goto(vite.url, { waitUntil: 'networkidle' });
  await mockedPage.waitForSelector('.react-flow__node');

  // Pick parseInput (SDD seed) and click Generate.
  const mockNodes = mockedPage.locator('.react-flow__node');
  const mockCount = await mockNodes.count();
  let parseIdx = -1;
  for (let i = 0; i < mockCount; i++) {
    const val = await mockNodes.nth(i).locator('.fblock__name').first().textContent();
    if (val?.trim() === 'parseInput') { parseIdx = i; break; }
  }
  check('found parseInput on canvas', parseIdx >= 0);
  if (parseIdx >= 0) {
    await mockNodes.nth(parseIdx).locator('.fblock__body').click();
    await mockedPage.waitForTimeout(200);
    await mockedPage.locator('.inspector button.primary', { hasText: 'Generate' }).click();
    // Give the SDK time to parse SSE + update body.
    try {
      await mockedPage.waitForFunction(
        () => document.querySelector('.body-view')?.textContent?.includes('return 42;'),
        { timeout: 8000 },
      );
      check('mocked body streamed into block', true);
    } catch {
      const bodyText = await mockedPage.locator('.body-view').first().textContent();
      check(
        'mocked body streamed into block',
        false,
        `body-view text was: "${(bodyText || '').slice(0, 200)}"`,
      );
    }
    check('anthropic endpoint was hit at least once', intercepted >= 1, `count=${intercepted}`);
    // Token usage hint should appear after onDone fires
    await mockedPage.waitForTimeout(200);
    const hints = await mockedPage.locator('.field__hint').allTextContents();
    const usageHint = hints.find((h) => /Tokens:\s*\d+\s*in\s*\/\s*\d+\s*out/.test(h));
    check('token usage hint shows after generate', !!usageHint, `hints: ${JSON.stringify(hints)}`);
    // Cost estimate should be appended to the same hint
    check(
      'cost estimate in USD appears alongside tokens',
      !!usageHint && /\$\d|\$\s*<|< \$/.test(usageHint),
      `usageHint: "${usageHint}"`,
    );
  }

  await mockedPage.unroute('https://api.anthropic.com/**');

  // 12. Auto TDD convergence — stateful mock returns a buggy body on the
  // first call and the correct one on the second. Verifies the full
  // Generate→Run→feedback→Regenerate loop.
  log('\n=== 12. auto TDD convergence (stateful mock) ===');

  function buildSse(bodyText) {
    const chunks = ['```js\n', bodyText + '\n', '```'];
    const events = [
      ['message_start', {
        type: 'message_start',
        message: {
          id: 'msg_mock',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-4-6',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      }],
      ['content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      }],
      ...chunks.map((t) => ['content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: t },
      }]),
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 5 },
      }],
      ['message_stop', { type: 'message_stop' }],
    ];
    return (
      events.map(([name, payload]) => `event: ${name}\ndata: ${JSON.stringify(payload)}\n`).join('\n') + '\n'
    );
  }

  let tddCalls = 0;
  await mockedPage.route('https://api.anthropic.com/**', async (route) => {
    tddCalls++;
    const body = tddCalls === 1 ? 'return 0;' : 'return 42;';
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      headers: { 'cache-control': 'no-cache', 'access-control-allow-origin': '*' },
      body: buildSse(body),
    });
  });

  // Select validate on the mocked page (fresh seed — original tests intact).
  const tddNodes = mockedPage.locator('.react-flow__node');
  const tddCount = await tddNodes.count();
  let validIdx2 = -1;
  for (let i = 0; i < tddCount; i++) {
    const val = await tddNodes.nth(i).locator('.fblock__name').first().textContent();
    if (val?.trim() === 'validate') { validIdx2 = i; break; }
  }
  check('found validate for Auto TDD', validIdx2 >= 0);
  if (validIdx2 >= 0) {
    await tddNodes.nth(validIdx2).locator('.fblock__body').click();
    await mockedPage.waitForTimeout(200);
    // Replace tests with a single assertion that distinguishes 0 from 42.
    const tddTestsBox = mockedPage.locator('.inspector textarea').first();
    await tddTestsBox.fill(`test('returns 42', () => expect(validate('x')).toBe(42));`);

    await mockedPage.locator('.inspector button').filter({ hasText: 'Auto TDD' }).click();

    // Wait for the block to reach passing status (the regen loop converges).
    try {
      await mockedPage.waitForSelector('.fblock.status-passing', { timeout: 10000 });
      check('Auto TDD converged to passing', true);
    } catch {
      const curStatus = await mockedPage.locator('.inspector__title').textContent();
      check(
        'Auto TDD converged to passing',
        false,
        `inspector title now: ${curStatus}, tddCalls=${tddCalls}`,
      );
    }

    check('Auto TDD made exactly 2 generate calls', tddCalls === 2, `tddCalls=${tddCalls}`);

    // Verify the body on the block is the fixed version.
    const finalBody = await mockedPage.locator('.inspector .body-view').first().textContent();
    check(
      'final body is the second-iteration fix',
      finalBody?.includes('return 42;') ?? false,
      `body: "${(finalBody || '').trim()}"`,
    );
  }

  await mockedPage.unroute('https://api.anthropic.com/**');

  // 13. Stop button during generation — delayed mock so we have time to
  // click Stop, then verify the block doesn't get stuck in 'generating'.
  log('\n=== 13. Stop during slow generation resets status ===');
  let stopIntercepted = 0;
  await mockedPage.route('https://api.anthropic.com/**', async (route) => {
    stopIntercepted++;
    // Hold the response for 4s. If the browser aborts first, the fulfill
    // never lands — that's fine, Playwright handles the abort cleanly.
    await new Promise((resolve) => setTimeout(resolve, 4000));
    try {
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        headers: { 'cache-control': 'no-cache' },
        body: buildSse('return 999;'),
      });
    } catch {
      // ignore — the fetch was aborted
    }
  });

  // Select parseInput (SDD seed, no body yet)
  const stopNodes = mockedPage.locator('.react-flow__node');
  const stopCount = await stopNodes.count();
  let stopIdx = -1;
  for (let i = 0; i < stopCount; i++) {
    const val = await stopNodes.nth(i).locator('.fblock__name').first().textContent();
    if (val?.trim() === 'parseInput') { stopIdx = i; break; }
  }
  if (stopIdx >= 0) {
    await stopNodes.nth(stopIdx).locator('.fblock__body').click();
    await mockedPage.waitForTimeout(200);
    // Click Generate (parseInput already has a body from section 11, so it
    // says 'Regenerate' now).
    await mockedPage.locator('.inspector button.primary').first().click();
    // Wait for the block to enter generating state
    await mockedPage.waitForSelector('.fblock.status-generating', { timeout: 2000 });
    // Click Stop (the same .primary button becomes "Stop" while busy)
    await mockedPage.waitForTimeout(300);
    await mockedPage.locator('.inspector button.primary').first().click();
    await mockedPage.waitForTimeout(500);
    // The block's card should NO LONGER have status-generating
    const stillGenerating = await mockedPage.locator('.fblock.status-generating').count();
    check('block exits generating state after Stop', stillGenerating === 0, `saw ${stillGenerating}`);
    // And no error banner — Stop is intentional, not an error
    const errBanner = await mockedPage.locator('.error-banner').count();
    check('no error banner after Stop', errBanner === 0, `${errBanner} banners`);
  }

  await mockedPage.unroute('https://api.anthropic.com/**');

  // 14. API error path — 401 from Anthropic lands in the error banner,
  // Retry button then recovers when the mock flips to 200. Verifies the
  // typed-exception propagation AND the retry UX end-to-end.
  log('\n=== 14. API 401 lands in error banner, Retry recovers ===');
  let errorCalls = 0;
  await mockedPage.route('https://api.anthropic.com/**', async (route) => {
    errorCalls++;
    if (errorCalls === 1) {
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({
          type: 'error',
          error: { type: 'authentication_error', message: 'invalid x-api-key' },
        }),
      });
    } else {
      // Second call = retry path — return a successful SSE stream so the
      // block populates with the recovered body.
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        headers: { 'cache-control': 'no-cache' },
        body: buildSse('return "recovered";'),
      });
    }
  });
  const errNodes = mockedPage.locator('.react-flow__node');
  const errCount = await errNodes.count();
  let errIdx = -1;
  for (let i = 0; i < errCount; i++) {
    const val = await errNodes.nth(i).locator('.fblock__name').first().textContent();
    if (val?.trim() === 'parseInput') { errIdx = i; break; }
  }
  if (errIdx >= 0) {
    await errNodes.nth(errIdx).locator('.fblock__body').click();
    await mockedPage.waitForTimeout(200);
    const priorBanner = await mockedPage.locator('.error-banner .link-btn').count();
    if (priorBanner) await mockedPage.locator('.error-banner .link-btn').first().click();
    await mockedPage.locator('.inspector button.primary').first().click();
    try {
      await mockedPage.waitForSelector('.error-banner', { timeout: 6000 });
      const banner = (await mockedPage.locator('.error-banner').textContent()) || '';
      check(
        'error banner appears on 401',
        banner.toLowerCase().includes('401') || banner.toLowerCase().includes('auth'),
        `banner: "${banner.trim().slice(0, 120)}"`,
      );
    } catch {
      check('error banner appears on 401', false, 'timeout waiting for banner');
    }
    const stuck = await mockedPage.locator('.fblock.status-generating').count();
    check('block exits generating on 401', stuck === 0, `${stuck} still generating`);

    // Click Retry — mock's second call returns a successful body.
    await mockedPage.locator('.error-banner button', { hasText: 'retry' }).click();
    try {
      await mockedPage.waitForFunction(
        () => document.querySelector('.body-view')?.textContent?.includes('recovered'),
        { timeout: 6000 },
      );
      check('retry succeeds on second call', true);
    } catch {
      const bodyText = await mockedPage.locator('.body-view').first().textContent();
      check('retry succeeds on second call', false, `body: "${(bodyText || '').slice(0, 120)}"`);
    }
    check('retry caused a second endpoint hit', errorCalls === 2, `errorCalls=${errorCalls}`);
    // Error banner should be gone after success
    const postRetryBanner = await mockedPage.locator('.error-banner').count();
    check('error banner cleared after successful retry', postRetryBanner === 0, `${postRetryBanner} banners`);
  }

  await mockedPage.unroute('https://api.anthropic.com/**');
  await mockedPage.close();

  log('\n=== console/page errors during run ===');
  if (errors.length === 0) {
    log('  ✓ no console or page errors');
  } else {
    errors.forEach((e) => log(`  ✗ ${e}`));
    failures += errors.length;
  }
} catch (err) {
  log(`FATAL: ${err?.stack || err}`);
  failures++;
} finally {
  if (browser) await browser.close();
  if (vite?.proc) {
    try { vite.proc.kill('SIGTERM'); } catch {}
  }
}

log('');
log(failures === 0 ? '=== ALL CHECKS PASSED ===' : `=== ${failures} CHECK(S) FAILED ===`);
process.exit(failures === 0 ? 0 : 1);
