import { useSettingsStore } from './settingsStore';
import { LANGUAGES } from './languages';

const MODELS = [
  { id: 'claude-opus-4-6', label: 'Claude Opus 4.6 (best)' },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (balanced)' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 (fast)' },
];

export function SettingsModal() {
  const isOpen = useSettingsStore((s) => s.isOpen);
  const apiKey = useSettingsStore((s) => s.apiKey);
  const model = useSettingsStore((s) => s.model);
  const language = useSettingsStore((s) => s.language);
  const setApiKey = useSettingsStore((s) => s.setApiKey);
  const setModel = useSettingsStore((s) => s.setModel);
  const setLanguage = useSettingsStore((s) => s.setLanguage);
  const close = useSettingsStore((s) => s.close);

  if (!isOpen) return null;

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal__header">
          <span>Settings</span>
          <button className="icon-btn" onClick={close} aria-label="Close">×</button>
        </div>
        <div className="modal__body">
          <label className="field">
            <span className="field__label">Anthropic API key</span>
            <input
              className="field__input"
              type="password"
              placeholder="sk-ant-..."
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
            <span className="field__hint">
              Stored in localStorage. Calls go directly from your browser to the Anthropic API.
            </span>
          </label>

          <label className="field">
            <span className="field__label">Model</span>
            <select
              className="field__input"
              value={model}
              onChange={(e) => setModel(e.target.value)}
            >
              {MODELS.map((m) => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </select>
          </label>

          <label className="field">
            <span className="field__label">Default language</span>
            <select
              className="field__input"
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
            >
              {LANGUAGES.map((l) => (
                <option key={l.id} value={l.id}>{l.label}</option>
              ))}
            </select>
            <span className="field__hint">
              Used by blocks that don't override it. Individual blocks can pick their own.
            </span>
          </label>
        </div>
        <div className="modal__footer">
          <button className="primary" onClick={close}>Done</button>
        </div>
      </div>
    </div>
  );
}
