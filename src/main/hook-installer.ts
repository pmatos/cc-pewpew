import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  appendFileSync,
  renameSync,
  rmSync,
} from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { join } from 'path'
import { homedir } from 'os'
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

function buildCodexHooks(notifyScript: string): Record<string, unknown[]> {
  const hook = { type: 'command', command: notifyScript }
  return {
    SessionStart: [{ hooks: [hook] }],
    Stop: [{ hooks: [hook] }],
    PostToolUse: [{ matcher: '.*', hooks: [hook] }],
  }
}

function ccPewpewHookJson(notifyScript: string): string {
  return JSON.stringify(buildHooks(notifyScript))
}

function ccPewpewCodexHookJson(notifyScript: string): string {
  return JSON.stringify(buildCodexHooks(notifyScript))
}

function atomicWrite(path: string, contents: string): void {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, contents)
  renameSync(tmp, path)
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

// Codex hook config is a JSON file at <project>/.codex/hooks.json. The shape
// mirrors Claude's `hooks` block (event → matcher groups → handlers) but lives
// in its own file rather than under a settings key.
export async function installCodexHooks(
  projectPath: string,
  { skipGitignore = false }: { skipGitignore?: boolean } = {}
): Promise<void> {
  const codexDir = join(projectPath, '.codex')
  mkdirSync(codexDir, { recursive: true })

  const hooksPath = join(codexDir, 'hooks.json')

  let existing: Record<string, unknown> = {}
  if (existsSync(hooksPath)) {
    try {
      existing = JSON.parse(readFileSync(hooksPath, 'utf-8'))
    } catch {
      existing = {}
    }
  }

  const newHooks = buildCodexHooks(NOTIFY_SCRIPT)
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
  atomicWrite(hooksPath, JSON.stringify(existing, null, 2))

  if (!skipGitignore) {
    ensureGitignore(projectPath, '.codex/hooks.json')
  }
}

export async function installRemoteCodexHooks(
  execRemote: (argv: string[], opts?: { timeoutMs?: number }) => Promise<ExecResult>,
  worktreePath: string,
  notifyScriptPath: string
): Promise<void> {
  const hooksJson = ccPewpewCodexHookJson(notifyScriptPath)
  const script =
    'set -e\n' +
    'codex_dir="$1/.codex"\n' +
    'hooks="$codex_dir/hooks.json"\n' +
    'mkdir -p "$codex_dir"\n' +
    'if [ -s "$hooks" ]; then cat "$hooks"; else printf "{}"; fi |\n' +
    'jq --argjson newHooks "$2" \'\n' +
    '  .hooks = (.hooks // {}) |\n' +
    '  reduce ($newHooks | keys[]) as $k (.;\n' +
    '    .hooks[$k] = (((.hooks[$k] // []) | map(select(((. | tostring) | contains("cc-pewpew")) | not))) + $newHooks[$k])\n' +
    '  )\n' +
    '\' > "$hooks.tmp"\n' +
    'mv "$hooks.tmp" "$hooks"\n'
  const result = await execRemote(['sh', '-c', script, '_', worktreePath, hooksJson], {
    timeoutMs: 15000,
  })
  if (result.timedOut || result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`
    throw new Error(`Failed to install remote codex hooks: ${detail}`)
  }
}

// Best-effort cleanup if the feature-flag enable step fails after we've already
// written .codex/hooks.json. The caller re-throws the original error.
export function rollbackCodexHooks(projectPath: string): void {
  try {
    rmSync(join(projectPath, '.codex', 'hooks.json'), { force: true })
  } catch {
    // ignore — best-effort
  }
}

const CODEX_CONFIG_PATH = join(homedir(), '.codex', 'config.toml')

// Hand-rolled minimal TOML merge — codex hooks are gated behind
// `[features].codex_hooks = true`. We avoid pulling a TOML dep just for one
// boolean, so this finds the [features] table and either sets, replaces, or
// inserts the key. Any other content is preserved verbatim.
export function mergeCodexHooksFlag(input: string): string {
  const lines = input.split('\n')
  const isFeaturesHeader = (l: string): boolean => /^\s*\[\s*features\s*\]\s*(#.*)?$/.test(l)
  const isOtherTable = (l: string): boolean => /^\s*\[/.test(l) && !isFeaturesHeader(l)
  const codexHooksKey = /^\s*codex_hooks\s*=/

  let inFeatures = false
  let featuresHeaderIdx = -1
  let foundKeyIdx = -1
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (isFeaturesHeader(line)) {
      inFeatures = true
      featuresHeaderIdx = i
      continue
    }
    if (inFeatures && isOtherTable(line)) {
      inFeatures = false
      continue
    }
    if (inFeatures && codexHooksKey.test(line)) {
      foundKeyIdx = i
      break
    }
  }

  if (foundKeyIdx >= 0) {
    if (/^\s*codex_hooks\s*=\s*true\s*(#.*)?$/.test(lines[foundKeyIdx])) return input
    lines[foundKeyIdx] = 'codex_hooks = true'
    return lines.join('\n')
  }

  if (featuresHeaderIdx >= 0) {
    lines.splice(featuresHeaderIdx + 1, 0, 'codex_hooks = true')
    return lines.join('\n')
  }

  const trailing = input.length === 0 || input.endsWith('\n') ? '' : '\n'
  return `${input}${trailing}\n[features]\ncodex_hooks = true\n`
}

export function ensureCodexHooksFeatureFlag(): void {
  mkdirSync(join(homedir(), '.codex'), { recursive: true })
  let current = ''
  if (existsSync(CODEX_CONFIG_PATH)) {
    current = readFileSync(CODEX_CONFIG_PATH, 'utf-8')
  }
  const next = mergeCodexHooksFlag(current)
  if (next === current) return
  atomicWrite(CODEX_CONFIG_PATH, next)
}

export async function ensureRemoteCodexHooksFeatureFlag(
  execRemote: (argv: string[], opts?: { timeoutMs?: number }) => Promise<ExecResult>
): Promise<void> {
  // Mirrors mergeCodexHooksFlag in shell: parse line-by-line via awk, set
  // codex_hooks=true inside [features], inserting the table if absent. Atomic
  // via tmp+mv. Idempotent — re-running yields identical content.
  const script =
    'set -e\n' +
    'cfg="$HOME/.codex/config.toml"\n' +
    'mkdir -p "$HOME/.codex"\n' +
    '[ -f "$cfg" ] || printf "" > "$cfg"\n' +
    "awk '\n" +
    '  BEGIN { inFeat=0; injected=0; replaced=0 }\n' +
    '  /^[[:space:]]*\\[[[:space:]]*features[[:space:]]*\\][[:space:]]*(#.*)?$/ { print; inFeat=1; next }\n' +
    '  /^[[:space:]]*\\[/ {\n' +
    '    if (inFeat==1 && injected==0 && replaced==0) { print "codex_hooks = true"; injected=1 }\n' +
    '    inFeat=0; print; next\n' +
    '  }\n' +
    '  inFeat==1 && /^[[:space:]]*codex_hooks[[:space:]]*=/ { print "codex_hooks = true"; replaced=1; next }\n' +
    '  { print }\n' +
    '  END {\n' +
    '    if (replaced==1) exit 0\n' +
    '    if (inFeat==1 && injected==0) { print "codex_hooks = true"; exit 0 }\n' +
    '    if (injected==0) { print ""; print "[features]"; print "codex_hooks = true" }\n' +
    '  }\n' +
    '\' "$cfg" > "$cfg.tmp"\n' +
    'mv "$cfg.tmp" "$cfg"\n'
  const result = await execRemote(['sh', '-c', script], { timeoutMs: 10000 })
  if (result.timedOut || result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`
    throw new Error(`Failed to enable codex hooks feature flag on remote: ${detail}`)
  }
}
