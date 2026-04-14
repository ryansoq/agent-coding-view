import { memo, useCallback, useState } from 'react';
import { Handle, Position, NodeProps } from 'reactflow';
import { DevMode, FunctionBlockData } from './types';
import { useGraphStore } from './store';
import { useSettingsStore } from './settingsStore';
import { labelFor } from './languages';

const MODE_CYCLE: DevMode[] = ['SDD', 'TDD', 'manual'];

function FunctionBlockNodeImpl({ id, data, selected }: NodeProps<FunctionBlockData>) {
  const patch = useGraphStore((s) => s.patchBlock);
  const defaultLanguage = useSettingsStore((s) => s.language);
  const effectiveLanguage = data.language || defaultLanguage;

  const [editingName, setEditingName] = useState(false);

  const onNameChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => patch(id, { name: e.target.value }),
    [id, patch],
  );

  const onToggleMode = useCallback(() => {
    const next = MODE_CYCLE[(MODE_CYCLE.indexOf(data.mode) + 1) % MODE_CYCLE.length];
    patch(id, { mode: next });
  }, [id, data.mode, patch]);

  return (
    <div className={`fblock status-${data.status} ${selected ? 'selected' : ''}`}>
      <Handle type="target" position={Position.Left} />
      <div className="fblock__header">
        {editingName ? (
          <input
            className="fblock__name"
            value={data.name}
            autoFocus
            onChange={onNameChange}
            onBlur={() => setEditingName(false)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === 'Escape') {
                e.currentTarget.blur();
              }
            }}
            onMouseDown={(e) => e.stopPropagation()}
            spellCheck={false}
          />
        ) : (
          <span
            className="fblock__name fblock__name--display"
            title="double-click to rename"
            onDoubleClick={(e) => {
              e.stopPropagation();
              setEditingName(true);
            }}
          >
            {data.name || 'untitled'}
          </span>
        )}
        <span
          className={`mode-badge ${data.mode}`}
          title="click to cycle mode"
          onClick={onToggleMode}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {data.mode}
        </span>
      </div>
      <div className="fblock__sig">{data.signature}</div>
      <div className={`fblock__body ${data.body ? '' : 'empty'}`}>
        {data.body || '// body not generated yet'}
      </div>
      <div className="fblock__footer">
        <span className={`status-dot ${data.status}`} />
        <span>{data.status}</span>
        <span className="lang-chip" title={data.language ? 'block language' : 'inherited from global'}>
          {labelFor(effectiveLanguage)}{!data.language && ' ·'}
        </span>
        <span style={{ flex: 1 }} />
        <span>{data.scope.length > 0 ? `scope: ${data.scope.length}` : 'scope: —'}</span>
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

export const FunctionBlockNode = memo(FunctionBlockNodeImpl);
