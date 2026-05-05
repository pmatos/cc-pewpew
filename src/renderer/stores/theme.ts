import { create } from 'zustand'
import type { Theme } from '../../shared/types'

const THEME_CHANGED_EVENT = 'cc-pewpew:theme-changed'

function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme
  window.dispatchEvent(new CustomEvent<Theme>(THEME_CHANGED_EVENT, { detail: theme }))
}

interface ThemeStore {
  theme: Theme
  loaded: boolean
  init: () => Promise<void>
  setTheme: (theme: Theme) => void
  toggle: () => void
}

export const useThemeStore = create<ThemeStore>((set, get) => ({
  theme: 'dark',
  loaded: false,
  init: async () => {
    if (get().loaded) return
    const persisted = await window.api.getTheme()
    applyTheme(persisted)
    set({ theme: persisted, loaded: true })
  },
  setTheme: (theme) => {
    if (get().theme === theme) return
    applyTheme(theme)
    set({ theme })
    void window.api.saveTheme(theme)
  },
  toggle: () => {
    get().setTheme(get().theme === 'dark' ? 'light' : 'dark')
  },
}))

export function onThemeChanged(callback: (theme: Theme) => void): () => void {
  const handler = (e: Event) => {
    const ce = e as CustomEvent<Theme>
    callback(ce.detail)
  }
  window.addEventListener(THEME_CHANGED_EVENT, handler)
  return () => window.removeEventListener(THEME_CHANGED_EVENT, handler)
}
