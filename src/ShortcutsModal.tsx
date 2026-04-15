interface Props {
  isOpen: boolean;
  onClose: () => void;
}

interface Shortcut {
  keys: string[];
  label: string;
}

interface Group {
  title: string;
  items: Shortcut[];
}

// Detect Mac once at module load — used to show ⌘ vs Ctrl in the key hints.
// navigator.platform is deprecated but the modern `userAgentData` isn't in
// Firefox yet, so we fall back.
const isMac =
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad|iPod/.test(navigator.platform);
const CTRL = isMac ? '⌘' : 'Ctrl';

const GROUPS: Group[] = [
  {
    title: 'Global',
    items: [
      { keys: [CTRL, 'K'], label: 'Focus search box' },
      { keys: [CTRL, 'Z'], label: 'Undo' },
      { keys: [CTRL, 'Shift', 'Z'], label: 'Redo' },
      { keys: [CTRL, 'Y'], label: 'Redo (alt)' },
      { keys: ['?'], label: 'Show this cheat sheet' },
    ],
  },
  {
    title: 'Block actions',
    items: [
      { keys: [CTRL, 'Enter'], label: 'Run tests on selected block' },
      { keys: [CTRL, 'Shift', 'Enter'], label: 'Run every TDD block' },
      { keys: ['Delete'], label: 'Delete selected block(s) / edge(s)' },
    ],
  },
  {
    title: 'Canvas',
    items: [
      { keys: ['Drag'], label: 'Pan the canvas' },
      { keys: ['Scroll'], label: 'Zoom in / out' },
      { keys: ['Shift', 'click'], label: 'Add to multi-selection' },
    ],
  },
];

export function ShortcutsModal({ isOpen, onClose }: Props) {
  if (!isOpen) return null;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal__header">
          <span>Keyboard shortcuts</span>
          <button className="icon-btn" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="modal__body">
          {GROUPS.map((group) => (
            <div key={group.title} className="shortcut-group">
              <div className="shortcut-group__title">{group.title}</div>
              {group.items.map((s) => (
                <div key={s.label} className="shortcut-row">
                  <div className="shortcut-row__keys">
                    {s.keys.map((k, i) => (
                      <span key={i}>
                        <kbd className="kbd">{k}</kbd>
                        {i < s.keys.length - 1 && <span className="shortcut-sep">+</span>}
                      </span>
                    ))}
                  </div>
                  <div className="shortcut-row__label">{s.label}</div>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
