import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

export interface CanvasState {
  zoom: number
  panX: number
  panY: number
}

export interface WindowState {
  x: number
  y: number
  width: number
  height: number
  maximized: boolean
}

export interface AppConfig {
  scanDirs: string[]
  canvas: CanvasState
  clusterPositions: Record<string, { x: number; y: number }>
  windowState?: WindowState
  sidebarWidth: number
  uiScale: number
}

export const CONFIG_DIR = join(
  process.env.XDG_CONFIG_HOME || join(homedir(), '.config'),
  'cc-pewpew'
)
const CONFIG_PATH = join(CONFIG_DIR, 'config.json')

const DEFAULT_CONFIG: AppConfig = {
  scanDirs: ['~/dev'],
  canvas: { zoom: 0.7, panX: 0, panY: 0 },
  clusterPositions: {},
  sidebarWidth: 250,
  uiScale: 1.2,
}

export function resolvePath(p: string): string {
  if (p.startsWith('~/')) {
    return join(homedir(), p.slice(2))
  }
  return p
}

export function getConfig(): AppConfig {
  mkdirSync(CONFIG_DIR, { recursive: true })

  if (!existsSync(CONFIG_PATH)) {
    writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2))
    return DEFAULT_CONFIG
  }

  try {
    const raw = readFileSync(CONFIG_PATH, 'utf-8')
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) }
  } catch {
    return DEFAULT_CONFIG
  }
}

export function saveConfig(config: AppConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true })
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2))
}
