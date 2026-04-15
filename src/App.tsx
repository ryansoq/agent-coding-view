import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactFlow, {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlowProvider,
} from 'reactflow';
import 'reactflow/dist/style.css';
import { FunctionBlockNode } from './FunctionBlockNode';
import { useGraphStore } from './store';
import { Inspector } from './Inspector';
import { SettingsModal } from './SettingsModal';
import { useSettingsStore } from './settingsStore';
import { computeLayout } from './layout';
import { exportGraph, exportAllLanguages } from './exporter';
import { importSource } from './importer';
import { IssuesModal } from './IssuesModal';
import { TemplatesModal } from './TemplatesModal';
import { ShortcutsModal } from './ShortcutsModal';
import { countIssues } from './validation';
import { useCostStore } from './costStore';
import { formatCost } from './pricing';
import { runTests, isLanguageSandboxed } from './sandbox/runner';

function Canvas() {
  const nodes = useGraphStore((s) => s.nodes);
  const edges = useGraphStore((s) => s.edges);
  const onNodesChange = useGraphStore((s) => s.onNodesChange);
  const onEdgesChange = useGraphStore((s) => s.onEdgesChange);
  const onConnect = useGraphStore((s) => s.onConnect);
  const addBlock = useGraphStore((s) => s.addBlock);
  const deleteSelected = useGraphStore((s) => s.deleteSelected);
  const toJSON = useGraphStore((s) => s.toJSON);
  const fromJSON = useGraphStore((s) => s.fromJSON);
  const reset = useGraphStore((s) => s.reset);
  const undo = useGraphStore((s) => s.undo);
  const redo = useGraphStore((s) => s.redo);
  const applyLayout = useGraphStore((s) => s.applyLayout);
  const importGraph = useGraphStore((s) => s.importGraph);
  const canUndo = useGraphStore((s) => s.history.length > 0);
  const canRedo = useGraphStore((s) => s.future.length > 0);
  // countIssues returns a fresh object so we can't inline it in the selector
  // without triggering a re-render every tick. useMemo on nodes/edges refs
  // keeps recomputation cheap.
  const issueCounts = useMemo(() => countIssues(nodes, edges), [nodes, edges]);
  const sessionCost = useCostStore((s) => s.totalUsd);
  const sessionCalls = useCostStore((s) => s.callCount);
  const resetCost = useCostStore((s) => s.reset);

  const [issuesOpen, setIssuesOpen] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);

  const onRunAll = useCallback(async () => {
    const state = useGraphStore.getState();
    const defaultLang = useSettingsStore.getState().language;
    const candidates = state.nodes.filter((n) => {
      if (n.data.mode !== 'TDD') return false;
      if (!n.data.body.trim() || !n.data.tests.trim()) return false;
      const lang = n.data.language || defaultLang;
      return isLanguageSandboxed(lang);
    });
    if (candidates.length === 0) {
      alert('No runnable TDD blocks — need a body, tests, and a JS/TS/Python language.');
      return;
    }
    // Sequential, not parallel — Python uses a singleton worker that
    // wouldn't tolerate concurrent calls anyway, and ordering keeps the
    // UI predictable.
    for (const block of candidates) {
      const lang = block.data.language || defaultLang;
      state.patchBlock(block.id, { status: 'running_tests' });
      const handle = runTests({
        language: lang,
        functionName: block.data.name,
        signature: block.data.signature,
        body: block.data.body,
        tests: block.data.tests,
      });
      const result = await handle.promise;
      if (result.status === 'done') {
        const passed = result.results.filter((r) => r.ok).length;
        const total = result.results.length;
        const allOk = total > 0 && passed === total;
        state.patchBlock(block.id, {
          status: allOk ? 'passing' : 'failing',
          testCounts: { passed, total },
        });
      } else {
        state.patchBlock(block.id, {
          status: 'failing',
          testCounts: { passed: 0, total: 0 },
        });
      }
    }
  }, []);

  const onLayout = useCallback(async () => {
    const { nodes: n, edges: e } = useGraphStore.getState();
    if (n.length === 0) return;
    const positions = await computeLayout(n, e);
    applyLayout(positions);
  }, [applyLayout]);

  const importInputRef = useRef<HTMLInputElement>(null);

  const onImportClick = useCallback(() => importInputRef.current?.click(), []);

  const onImportPicked = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const text = await file.text();
      try {
        const { nodes: parsedNodes, edges: parsedEdges } = importSource(text, file.name);
        if (parsedNodes.length === 0) {
          alert('No top-level function declarations found in the file.');
          return;
        }
        importGraph(parsedNodes, parsedEdges);
      } catch (err) {
        alert(`Import failed: ${(err as Error).message}`);
      }
      e.target.value = '';
    },
    [importGraph],
  );

  const downloadText = (filename: string, content: string) => {
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const onExport = useCallback(() => {
    const { nodes: n, edges: e } = useGraphStore.getState();
    const { language } = useSettingsStore.getState();
    if (n.length === 0) return;
    try {
      const { filename, content } = exportGraph(n, e, language, language);
      downloadText(filename, content);
    } catch (err) {
      alert(`Export failed: ${(err as Error).message}`);
    }
  }, []);

  const onExportAll = useCallback(async () => {
    const { nodes: n, edges: e } = useGraphStore.getState();
    const { language } = useSettingsStore.getState();
    if (n.length === 0) return;
    try {
      const results = exportAllLanguages(n, e, language);
      if (results.length === 0) {
        alert('No exportable blocks in the graph.');
        return;
      }
      for (const r of results) {
        downloadText(r.filename, r.content);
        // Small gap so the browser treats each download as its own gesture —
        // Chrome occasionally throttles back-to-back downloads otherwise.
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    } catch (err) {
      alert(`Export all failed: ${(err as Error).message}`);
    }
  }, []);

  const openSettings = useSettingsStore((s) => s.open);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const nodeTypes = useMemo(() => ({ fblock: FunctionBlockNode }), []);

  // Derived nodes with a search-dim className when a query is active
  // and the block doesn't match. Layout and positions stay intact so the
  // graph's structure is still legible — only visual opacity changes.
  const displayNodes = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return nodes;
    return nodes.map((n) => {
      const d = n.data;
      const hit =
        d.name.toLowerCase().includes(q) ||
        d.signature.toLowerCase().includes(q) ||
        d.body.toLowerCase().includes(q) ||
        d.spec.toLowerCase().includes(q) ||
        d.tests.toLowerCase().includes(q);
      return hit ? n : { ...n, className: 'search-dim' };
    });
  }, [nodes, search]);

  // Derived edges with animated=true when the downstream block is busy.
  // This gives a live "execution trace" effect during Run all or during
  // any in-flight generate — edges feeding a running block pulse so you
  // can see the flow advance. The store is untouched so onEdgesChange
  // still sees the original edge shape.
  const displayEdges = useMemo(() => {
    const busyTargets = new Set(
      nodes
        .filter(
          (n) => n.data.status === 'running_tests' || n.data.status === 'generating',
        )
        .map((n) => n.id),
    );
    if (busyTargets.size === 0) return edges;
    return edges.map((e) =>
      busyTargets.has(e.target) ? { ...e, animated: true } : e,
    );
  }, [edges, nodes]);

  const onSave = useCallback(() => {
    const blob = new Blob([toJSON()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `graph-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [toJSON]);

  const onLoad = useCallback(() => fileInputRef.current?.click(), []);

  const onFilePicked = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const text = await file.text();
      try {
        fromJSON(text);
      } catch (err) {
        alert(`Failed to load graph: ${(err as Error).message}`);
      }
      e.target.value = '';
    },
    [fromJSON],
  );

  // Ctrl/Cmd+Z for undo, Ctrl+Shift+Z or Ctrl+Y for redo. Skip when the
  // user is typing in a form field so native browser undo still works
  // inside the Inspector's textareas.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      const inField = tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable;
      const ctrl = e.ctrlKey || e.metaKey;
      // Ctrl/Cmd+K focuses the search input — works from anywhere,
      // including inside form fields, since it's a global app shortcut.
      if (ctrl && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
        return;
      }
      // Ctrl/Cmd+Enter runs the currently-selected block's tests.
      // Ctrl+Shift+Enter runs every TDD block in the graph.
      // These work from anywhere — including textareas, where you often
      // want to tweak a test and fire it without clicking away.
      if (ctrl && e.key === 'Enter') {
        e.preventDefault();
        if (e.shiftKey) {
          onRunAll();
        } else {
          // Delegate to Inspector via a DOM custom event — avoids ref
          // plumbing and keeps the shortcut handler decoupled from
          // whatever block is currently selected.
          window.dispatchEvent(new CustomEvent('acv:run-current-tests'));
        }
        return;
      }
      if (inField) return;
      // `?` anywhere (outside text fields) toggles the shortcut cheat sheet.
      // Shift is typically held to produce `?` on US layouts, but we check
      // the key itself so it works regardless of layout quirks.
      if (!ctrl && e.key === '?') {
        e.preventDefault();
        setShortcutsOpen((o) => !o);
        return;
      }
      if (!ctrl) return;
      if (e.key === 'z' || e.key === 'Z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (e.key === 'y' || e.key === 'Y') {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo, onRunAll]);

  return (
    <div className="app">
      <div className="toolbar">
        <span className="title">Agent Coding View</span>
        <span className="hint">P2</span>
        {sessionCalls > 0 && (
          <span
            className="session-cost"
            title={`${sessionCalls} generate call${sessionCalls === 1 ? '' : 's'} this session · click to reset`}
            onClick={resetCost}
          >
            Session: {formatCost(sessionCost)}
          </span>
        )}
        <input
          ref={searchInputRef}
          className="toolbar-search"
          type="search"
          placeholder="Search blocks  (⌘K)"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          spellCheck={false}
        />
        <span className="spacer" />
        <button className="primary" onClick={() => addBlock()}>+ Add block</button>
        <button onClick={() => setTemplatesOpen(true)} title="Create a block from a preset template">Templates</button>
        <button onClick={deleteSelected} title="Delete selected (Del)">Delete</button>
        <button onClick={undo} disabled={!canUndo} title="Undo (Ctrl/Cmd+Z)">Undo</button>
        <button onClick={redo} disabled={!canRedo} title="Redo (Ctrl+Shift+Z / Ctrl+Y)">Redo</button>
        <button onClick={onRunAll} title="Run tests on every TDD block in sequence">Run all</button>
        <button onClick={onLayout} title="Auto-layout via dagre (left→right)">Layout</button>
        <button onClick={onExport} title="Export all blocks of the default language as one source file">Export</button>
        <button onClick={onExportAll} title="Export every language group as a separate file">Export all</button>
        <button onClick={onImportClick} title="Import a .js or .py file — each top-level function becomes a block">Import</button>
        <button
          onClick={() => setIssuesOpen(true)}
          className={issueCounts.errors > 0 ? 'issues-btn issues-btn--has-errors' : issueCounts.warnings > 0 ? 'issues-btn issues-btn--has-warnings' : 'issues-btn'}
          title="Show all graph issues"
        >
          Issues{issueCounts.total > 0 ? ` (${issueCounts.total})` : ''}
        </button>
        <button onClick={onSave}>Save JSON</button>
        <button onClick={onLoad}>Load JSON</button>
        <button onClick={reset}>Clear</button>
        <button
          className="icon-btn"
          onClick={() => setShortcutsOpen(true)}
          title="Keyboard shortcuts (?)"
          aria-label="Keyboard shortcuts"
        >
          ?
        </button>
        <button
          className="icon-btn"
          onClick={openSettings}
          title="Settings"
          aria-label="Settings"
        >
          ⚙
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json"
          style={{ display: 'none' }}
          onChange={onFilePicked}
        />
        <input
          ref={importInputRef}
          type="file"
          accept=".js,.ts,.mjs,.py,text/javascript,text/x-python"
          style={{ display: 'none' }}
          onChange={onImportPicked}
        />
      </div>
      <div className="workspace">
        <div className="canvas">
          <ReactFlow
            nodes={displayNodes}
            edges={displayEdges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            nodeTypes={nodeTypes}
            fitView
            deleteKeyCode={['Delete', 'Backspace']}
            // Accept Shift/Ctrl/Meta as multi-select modifiers — the React
            // Flow default is Meta on Mac and Control elsewhere, which
            // surprises people used to Shift from Figma/VSCode.
            multiSelectionKeyCode={['Shift', 'Meta', 'Control']}
          >
            <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="#2a3244" />
            <Controls position="bottom-left" />
            <MiniMap
              position="bottom-right"
              pannable
              zoomable
              nodeColor={() => '#5b8cff'}
              maskColor="rgba(15,17,21,0.7)"
            />
          </ReactFlow>
        </div>
        <Inspector />
      </div>
      <SettingsModal />
      <IssuesModal isOpen={issuesOpen} onClose={() => setIssuesOpen(false)} />
      <TemplatesModal isOpen={templatesOpen} onClose={() => setTemplatesOpen(false)} />
      <ShortcutsModal isOpen={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
    </div>
  );
}

export default function App() {
  return (
    <ReactFlowProvider>
      <Canvas />
    </ReactFlowProvider>
  );
}
