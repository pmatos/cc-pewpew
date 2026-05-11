import { create } from 'zustand'
import type { Theme } from '../../shared/types'

const THEME_CHANGED_EVENT = 'pewpew:theme-changed'

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

let broadcastListenerInstalled = false

export const useThemeStore = create<ThemeStore>((set, get) => ({
  theme: 'dark',
  loaded: false,
  mutationCount: 0,
  init: async () => {
    if (get().loaded) return
    // Subscribe to cross-window theme broadcasts before the IPC await so
    // a change pushed by main during init isn't dropped. Doesn't go
    // through setTheme — setTheme would re-save and trigger another
    // broadcast.
    if (!broadcastListenerInstalled) {
      broadcastListenerInstalled = true
      window.api.onThemeBroadcast((theme) => {
        if (get().theme === theme) return
        applyTheme(theme)
        set({ theme, mutationCount: get().mutationCount + 1 })
      })
    }
    // Set `loaded` synchronously so a concurrent init() (StrictMode double
    // mount, second window) bails at the guard above instead of racing on
    // the same await.
    const initialMutation = get().mutationCount
    set({ loaded: true })
    const loadedTheme = await window.api.getTheme().then((theme) => ({
      theme,
      mutationCount: get().mutationCount,
    }))
    // If setTheme or a broadcast ran during the await, the latest theme
    // is already applied; do not clobber it with the value we fetched.
    if (loadedTheme.mutationCount !== initialMutation) return
    if (loadedTheme.theme === get().theme) return
    applyTheme(loadedTheme.theme)
    set({ theme: loadedTheme.theme })
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
