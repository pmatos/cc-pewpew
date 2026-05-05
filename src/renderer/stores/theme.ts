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
  // Monotonic counter incremented by setTheme on every actual state change.
  // init() captures it before its IPC await and bails if it changed,
  // catching a user toggle even when the net theme equals the initial value
  // (e.g. dark → light → dark during a slow getTheme()).
  mutationCount: number
  init: () => Promise<void>
  setTheme: (theme: Theme) => void
  toggle: () => void
}

export const useThemeStore = create<ThemeStore>((set, get) => ({
  theme: 'dark',
  loaded: false,
  mutationCount: 0,
  init: async () => {
    if (get().loaded) return
    // Set `loaded` synchronously so a concurrent init() (StrictMode double
    // mount, second window) bails at the guard above instead of racing on
    // the same await.
    const initialMutation = get().mutationCount
    set({ loaded: true })
    const persisted = await window.api.getTheme()
    // If setTheme ran during the await, the user's choice is already
    // applied and persisted; do not clobber it with the value we fetched.
    if (get().mutationCount !== initialMutation) return
    if (persisted === get().theme) return
    applyTheme(persisted)
    set({ theme: persisted })
  },
  setTheme: (theme) => {
    if (get().theme === theme) return
    applyTheme(theme)
    set({ theme, mutationCount: get().mutationCount + 1 })
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
