import { useCallback, useEffect, useMemo, useRef } from 'react';
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
  const canUndo = useGraphStore((s) => s.history.length > 0);
  const canRedo = useGraphStore((s) => s.future.length > 0);

  const onLayout = useCallback(async () => {
    const { nodes: n, edges: e } = useGraphStore.getState();
    if (n.length === 0) return;
    const positions = await computeLayout(n, e);
    applyLayout(positions);
  }, [applyLayout]);

  const openSettings = useSettingsStore((s) => s.open);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const nodeTypes = useMemo(() => ({ fblock: FunctionBlockNode }), []);

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
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return;
      const ctrl = e.ctrlKey || e.metaKey;
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
  }, [undo, redo]);

  return (
    <div className="app">
      <div className="toolbar">
        <span className="title">Agent Coding View</span>
        <span className="hint">P2</span>
        <span className="spacer" />
        <button className="primary" onClick={() => addBlock()}>+ Add block</button>
        <button onClick={deleteSelected} title="Delete selected (Del)">Delete</button>
        <button onClick={undo} disabled={!canUndo} title="Undo (Ctrl/Cmd+Z)">Undo</button>
        <button onClick={redo} disabled={!canRedo} title="Redo (Ctrl+Shift+Z / Ctrl+Y)">Redo</button>
        <button onClick={onLayout} title="Auto-layout via dagre (left→right)">Layout</button>
        <button onClick={onSave}>Save JSON</button>
        <button onClick={onLoad}>Load JSON</button>
        <button onClick={reset}>Clear</button>
        <button className="icon-btn" onClick={openSettings} title="Settings">⚙</button>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json"
          style={{ display: 'none' }}
          onChange={onFilePicked}
        />
      </div>
      <div className="workspace">
        <div className="canvas">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            nodeTypes={nodeTypes}
            fitView
            deleteKeyCode={['Delete', 'Backspace']}
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
