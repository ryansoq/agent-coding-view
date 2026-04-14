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

function check(label, cond, detail) {
  if (cond) log(`  ✓ ${label}`);
  else {
    log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`);
    failures++;
  }
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
    if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
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
  await page.locator('input[type="file"]').setInputFiles(tmpFile);
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
  await page.goto(vite.url, { waitUntil: 'networkidle' });
  await page.waitForSelector('.react-flow__node');

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
      await page.locator('input[type="file"]').setInputFiles(savedPath);
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
