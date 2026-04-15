# Agent Coding View

A visual, graph-based workspace for **AI-assisted coding**. Each node on the
canvas is a function; you describe it (spec or tests), Claude writes the body,
an in-browser sandbox runs the tests, and you iterate. The whole graph lives
in `localStorage`, so everything you build survives a reload with no backend.

![shipped](https://img.shields.io/badge/CI-passing-3ecf8e) 239 unit tests · 113 e2e checks · Typecheck · Build · E2E on every push.

---

## Why this exists

Chat-based coding loses the shape of a codebase. You end up with a long scroll
of turns instead of a map of functions and how they call each other. Agent
Coding View flips that: you see the functions as nodes, you see who calls who
as edges, and the LLM generates each block against its local neighborhood
rather than the whole transcript.

---

## Quickstart

```bash
npm install
npm run dev           # Vite dev server on http://localhost:5173
```

Then in the browser:

1. Open **Settings** (⚙) and paste an Anthropic API key. It lives in
   `localStorage` only — never sent anywhere except `api.anthropic.com`.
2. Click a seed block (`parseInput`, `validate`, …) to select it.
3. In the Inspector, write a spec (SDD) or tests (TDD).
4. Press **Generate** — Claude streams the body into the block.
5. For TDD blocks, hit **Run tests** or **Auto TDD** to iterate until green.

That's the whole loop. Everything else is polish around it.

> **No key?** You can still play — add blocks, import real `.js` / `.py`
> files, run tests against bodies you paste in yourself, use undo/redo, and
> explore the graph stats / Mermaid export. The sandbox doesn't need Claude.

---

## The canvas

Powered by [React Flow](https://reactflow.dev). You can:

- **Drag** nodes anywhere; connections auto-route
- **Connect** by dragging from a node's right handle to another's left handle
- **Pan** by dragging the background, **zoom** with scroll
- **Multi-select** with Shift/Ctrl/Meta-click or by dragging a box
- **Undo / redo** every structural change (add, delete, connect, disconnect)
- **Auto-layout** via dagre (left→right) — the **Layout** button

The minimap (bottom-right) paints each node by status, so you see failing
blocks at a glance no matter how far you've zoomed out.

---

## Blocks and modes

Every block has a `name`, `signature`, `language`, `status`, and either a
spec or a test suite depending on its **development mode**:

| Mode     | Input field  | Meaning                                                         |
|----------|--------------|-----------------------------------------------------------------|
| **SDD**  | Spec         | Plain English description — Claude writes the body from it.    |
| **TDD**  | Tests        | A test suite. Generate + run in a loop until everything passes. |
| **Manual** | Instructions | Free-form notes. No auto-loop; you drive it.                  |

Statuses: `stub` → `specd` → `generating` → `running_tests` → `passing` / `failing`.

The card footer shows `passed / total` test counts once you've run anything.

### Inspector

Selecting a block opens the right-hand Inspector with:

- **Name** (top)
- **Mode** segmented control (SDD / TDD / Manual)
- **Spec** or **Tests** textarea depending on mode
- **Body** panel with Generate / Stop / Run tests / Auto TDD buttons
- **Test results** with per-test pass/fail + runtime logs
- **Advanced** (collapsed `<details>`) — Language override, Signature, Scope globs

### Auto TDD

TDD mode + **Auto TDD** runs a streaming loop:

1. Generate body from the current tests + previous-attempt context
2. Run the tests in the sandbox
3. If all green → stop. Otherwise feed failures back to Claude and loop.
4. Bails out after `MAX_TDD_ITERATIONS` (currently 5).

---

## The in-browser sandbox

Tests run inside **Web Workers** — no eval on the main thread, no backend.

| Language          | Runtime                              | First-call latency            |
|-------------------|--------------------------------------|-------------------------------|
| JavaScript / TypeScript | Module worker, fresh per call    | ~instant                      |
| Python            | Singleton worker + Pyodide (CDN)     | ~10–15s first run (downloads) |

The runtime exposes a tiny test API mirrored across JS and Python:

```js
test('accepts valid', () => {
  expect(validate({ name: 'x' })).toBe(true);
});

// matchers: toBe, toEqual, toThrow, toBeTruthy, toBeFalsy, toBeCloseTo
```

Runaway bodies get killed by a watchdog timeout (~5s).

---

## Graph intelligence

The **Issues** button opens a modal with:

- **Graph stats** — blocks, edges, longest chain length, connected components,
  max fan-in / fan-out, passing vs failing counts, per-language and per-mode
  chips.
- **Errors** — blocks with failing tests (click to jump to them).
- **Warnings** — cycles (upstream/downstream ambiguous), duplicate block
  names, TDD blocks with no tests written.

Cycles are detected with iterative DFS; longest chain uses Kahn's topological
DP; components use union-find.

---

## Importing real code

Click **Import** and pick a `.js`, `.ts`, `.mjs`, or `.py` file. Every
top-level function becomes a block:

- **Bracket-balanced** parser handles nested parens, string literals, and
  `//` / `/* */` comments.
- **Call edges** are inferred automatically — if `foo` calls `bar` and both
  exist as blocks, you get a `bar → foo` edge.
- **Parameters** feed the generated signature so re-generation preserves
  the shape.

---

## Exporting

Four export buttons in the toolbar:

- **Save JSON** — the full graph (for reloading later with **Load JSON**)
- **Export** — the default-language blocks as one topologically-sorted source file
- **Export all** — one file per language present on the canvas
- **Mermaid** — `flowchart LR` rendering of the graph, copied to clipboard
  **and** downloaded as `.mmd`. Paste straight into PR descriptions /
  GitHub issues / markdown docs.

The Mermaid output carries per-status `classDef`s so rendered graphs color
passing blocks green, failing red, etc.

---

## Cost accounting

Every Claude call records input / output / cache tokens, estimates the
dollar cost using the current Anthropic pricing table, and accumulates a
**session total** in the toolbar chip. Click the chip to reset. Costs
persist to `localStorage` so a reload doesn't lose the count.

Prompt caching (`cache_control` on the system prompt) kicks in on the
second call for the same model, slashing input cost on re-generation and
Auto TDD iterations.

---

## Keyboard shortcuts

Press **`?`** anywhere (outside a text field) for the in-app cheat sheet.

| Shortcut          | Action                                    |
|-------------------|-------------------------------------------|
| `Ctrl/Cmd + K`    | Focus the toolbar search                  |
| `Ctrl/Cmd + Enter`| Run tests on the selected block           |
| `Ctrl + Shift + Enter` | Run every TDD block in sequence      |
| `Ctrl/Cmd + D`    | Duplicate the selected block              |
| `Ctrl/Cmd + Z`    | Undo structural change                    |
| `Ctrl + Shift + Z` / `Ctrl + Y` | Redo                        |
| `Delete` / `Backspace` | Delete selected block(s) / edge(s)   |
| `?`               | Toggle the shortcut cheat sheet           |

The search box dims non-matching blocks so you can still see them in context.

---

## Architecture sketch

```
src/
├── App.tsx                 # Canvas + toolbar + keyboard handlers + modals
├── Inspector.tsx           # Right-hand block editor (spec/tests/body)
├── FunctionBlockNode.tsx   # React Flow node renderer
├── store.ts                # Zustand — nodes, edges, history, persist
├── settingsStore.ts        # Zustand — api key, model, language
├── costStore.ts            # Zustand — token + cost accumulator
├── llm.ts                  # Anthropic SDK wrapper (streaming + cache_control)
├── sandbox/
│   ├── runner.ts           # Language dispatch + extractParams
│   ├── worker.ts           # JS module worker (fresh per call)
│   ├── jsRuntime.ts        # test() / expect() runtime shared with the worker
│   └── python-worker.ts    # Pyodide singleton
├── importer.ts             # .js / .py → blocks + inferCallEdges
├── exporter.ts             # blocks → .js / .py / .mmd
├── validation.ts           # Issues + graph stats
├── graph.ts                # cycle detection (iterative DFS)
├── layout.ts               # dagre wrapper (lazy-imported)
├── templates.ts            # preset block skeletons
└── pricing.ts              # per-model USD estimates
```

No backend. No server. Just Vite + React + a lot of careful Zustand.

---

## Developing

```bash
npm run dev        # Vite dev server
npm run build      # tsc + production build
npm run typecheck  # tsc -b --noEmit
npm test           # vitest (unit)
npm run test:e2e   # Playwright smoke test (spawns dev server)
```

CI runs all four on every push to `main`. See `.github/workflows/ci.yml`.

---

## Project status

Everything above is shipped and green on `main`. Plausible next-step ideas,
in rough order of value:

- Block **Notes** field — human-only annotations that don't feed the LLM
- **Hover a failing test** to see full stack / logs inline
- Render the Mermaid export inside the Issues modal as a preview
- Per-block **language chips** on the card (currently only in the header)
- Dark/light theme toggle (currently dark-only)

PRs welcome.
