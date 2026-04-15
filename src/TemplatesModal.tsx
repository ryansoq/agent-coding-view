import { useGraphStore } from './store';
import { TEMPLATES, BlockTemplate } from './templates';

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

export function TemplatesModal({ isOpen, onClose }: Props) {
  const addBlock = useGraphStore((s) => s.addBlock);

  if (!isOpen) return null;

  const onPick = (tpl: BlockTemplate) => {
    addBlock(undefined, tpl.data);
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal__header">
          <span>Block templates</span>
          <button className="icon-btn" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="modal__body">
          {TEMPLATES.map((tpl) => (
            <button
              key={tpl.id}
              className="template-row"
              onClick={() => onPick(tpl)}
            >
              <div className="template-row__label">{tpl.label}</div>
              <div className="template-row__desc">{tpl.description}</div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
