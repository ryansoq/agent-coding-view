import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface SettingsState {
  apiKey: string;
  model: string;
  language: string;
  isOpen: boolean;

  setApiKey: (k: string) => void;
  setModel: (m: string) => void;
  setLanguage: (l: string) => void;
  open: () => void;
  close: () => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      apiKey: '',
      model: 'claude-opus-4-6',
      language: 'typescript',
      isOpen: false,

      setApiKey: (k) => set({ apiKey: k }),
      setModel: (m) => set({ model: m }),
      setLanguage: (l) => set({ language: l }),
      open: () => set({ isOpen: true }),
      close: () => set({ isOpen: false }),
    }),
    {
      name: 'agent-coding-view:settings',
      partialize: (s) => ({ apiKey: s.apiKey, model: s.model, language: s.language }),
    },
  ),
);
