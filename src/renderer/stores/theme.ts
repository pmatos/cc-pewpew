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
    // Set `loaded` synchronously so a concurrent init() (StrictMode double
    // mount, second window) bails at the guard above instead of racing on
    // the same await.
    const initialTheme = get().theme
    set({ loaded: true })
    const persisted = await window.api.getTheme()
    // If the user toggled during the await, setTheme has already applied
    // and persisted their choice — don't clobber it with the stale value
    // we just fetched.
    if (get().theme !== initialTheme) return
    if (persisted === initialTheme) return
    applyTheme(persisted)
    set({ theme: persisted })
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
