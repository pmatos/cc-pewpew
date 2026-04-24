import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { join } from 'path'
import { CONFIG_DIR } from './config'
import type { ExecResult } from './host-connection'

const execFileAsync = promisify(execFile)

const NOTIFY_SCRIPT = join(CONFIG_DIR, 'hooks', 'notify.sh')

function buildHooks(notifyScript: string): Record<string, unknown[]> {
  const hook = { type: 'command', command: notifyScript }
  return {
    SessionStart: [{ hooks: [hook] }],
    Stop: [{ hooks: [hook] }],
    PostToolUse: [{ matcher: 'Read|Write|Edit|Bash', hooks: [hook] }],
    SessionEnd: [{ hooks: [hook] }],
    Notification: [{ hooks: [hook] }],
  }
}

function ccPewpewHookJson(notifyScript: string): string {
  return JSON.stringify(buildHooks(notifyScript))
}

export async function installHooks(
  projectPath: string,
  { skipGitignore = false }: { skipGitignore?: boolean } = {}
): Promise<void> {
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

  const newHooks = buildHooks(NOTIFY_SCRIPT)
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

  if (!skipGitignore) {
    ensureGitignore(projectPath, '.claude/settings.local.json')
  }
}

export async function installRemoteHooks(
  execRemote: (argv: string[], opts?: { timeoutMs?: number }) => Promise<ExecResult>,
  worktreePath: string,
  notifyScriptPath: string
): Promise<void> {
  const hooksJson = ccPewpewHookJson(notifyScriptPath)
  const script =
    'set -e\n' +
    'claude_dir="$1/.claude"\n' +
    'settings="$claude_dir/settings.local.json"\n' +
    'mkdir -p "$claude_dir"\n' +
    'if [ -s "$settings" ]; then cat "$settings"; else printf "{}"; fi |\n' +
    'jq --argjson newHooks "$2" \'\n' +
    '  .hooks = (.hooks // {}) |\n' +
    '  reduce ($newHooks | keys[]) as $k (.;\n' +
    '    .hooks[$k] = (((.hooks[$k] // []) | map(select(((. | tostring) | contains("cc-pewpew")) | not))) + $newHooks[$k])\n' +
    '  )\n' +
    '\' > "$settings.tmp"\n' +
    'mv "$settings.tmp" "$settings"\n'
  const result = await execRemote(['sh', '-c', script, '_', worktreePath, hooksJson], {
    timeoutMs: 15000,
  })
  if (result.timedOut || result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`
    throw new Error(`Failed to install remote hooks: ${detail}`)
  }
}

export async function isSettingsGitignored(projectPath: string): Promise<boolean> {
  try {
    await execFileAsync(
      'git',
      ['-C', projectPath, 'check-ignore', '-q', '.claude/settings.local.json'],
      { timeout: 5000 }
    )
    return true
  } catch {
    return false
  }
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
