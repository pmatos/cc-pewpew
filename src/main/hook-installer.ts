import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from 'fs'
import { join } from 'path'
import { CONFIG_DIR } from './config'

const NOTIFY_SCRIPT = join(CONFIG_DIR, 'hooks', 'notify.sh')

function buildHooks(): Record<string, unknown[]> {
  const hook = { type: 'command', command: NOTIFY_SCRIPT }
  return {
    SessionStart: [{ hooks: [hook] }],
    Stop: [{ hooks: [hook] }],
    PostToolUse: [{ matcher: 'Read|Write|Edit|Bash', hooks: [hook] }],
    SessionEnd: [{ hooks: [hook] }],
    Notification: [{ hooks: [hook] }],
  }
}

export async function installHooks(projectPath: string): Promise<void> {
  const claudeDir = join(projectPath, '.claude')
  mkdirSync(claudeDir, { recursive: true })

  const settingsPath = join(claudeDir, 'settings.local.json')

  let existing: Record<string, unknown> = {}
  if (existsSync(settingsPath)) {
    try {
      existing = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    } catch {
      existing = {}
    }
  }

  const newHooks = buildHooks()
  const existingHooks = (existing.hooks || {}) as Record<string, unknown[]>
  const merged: Record<string, unknown[]> = { ...existingHooks }

  for (const [event, entries] of Object.entries(newHooks)) {
    const kept = (existingHooks[event] || []).filter((entry) => {
      const json = JSON.stringify(entry)
      return !json.includes('cc-pewpew')
    })
    merged[event] = [...kept, ...entries]
  }

  existing.hooks = merged
  writeFileSync(settingsPath, JSON.stringify(existing, null, 2))

  ensureGitignore(projectPath, '.claude/settings.local.json')
}

function ensureGitignore(projectPath: string, entry: string): void {
  const gitignorePath = join(projectPath, '.gitignore')

  if (existsSync(gitignorePath)) {
    const content = readFileSync(gitignorePath, 'utf-8')
    if (content.includes(entry)) return
    appendFileSync(gitignorePath, `\n${entry}\n`)
  } else {
    writeFileSync(gitignorePath, `${entry}\n`)
  }
}
