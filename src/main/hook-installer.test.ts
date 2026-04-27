import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const state = {
  tmpHome: '',
  tmpProject: '',
}

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return { ...actual, homedir: () => state.tmpHome }
})

vi.mock('./config', () => ({
  CONFIG_DIR: '/tmp/cc-pewpew-test-config',
}))

beforeEach(() => {
  state.tmpHome = mkdtempSync(join(tmpdir(), 'codex-home-'))
  state.tmpProject = mkdtempSync(join(tmpdir(), 'codex-proj-'))
})

afterEach(() => {
  rmSync(state.tmpHome, { recursive: true, force: true })
  rmSync(state.tmpProject, { recursive: true, force: true })
})

async function loadInstaller(): Promise<typeof import('./hook-installer')> {
  vi.resetModules()
  return import('./hook-installer')
}

describe('installCodexHooks', () => {
  it('writes .codex/hooks.json with codex event shape', async () => {
    const { installCodexHooks } = await loadInstaller()
    await installCodexHooks(state.tmpProject, { skipGitignore: true })

    const json = JSON.parse(
      readFileSync(join(state.tmpProject, '.codex', 'hooks.json'), 'utf-8')
    ) as { hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>> }

    expect(json.hooks.SessionStart).toHaveLength(1)
    expect(json.hooks.Stop).toHaveLength(1)
    expect(json.hooks.PostToolUse).toHaveLength(1)
    expect(json.hooks.PostToolUse[0].matcher).toBe('.*')
    expect(json.hooks.SessionStart[0].hooks[0].command).toContain('cc-pewpew')
  })

  it('preserves existing non-cc-pewpew entries when merging', async () => {
    const codexDir = join(state.tmpProject, '.codex')
    mkdirSync(codexDir, { recursive: true })
    writeFileSync(
      join(codexDir, 'hooks.json'),
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: 'command', command: '/usr/local/bin/other-hook.sh' }] }],
        },
      })
    )

    const { installCodexHooks } = await loadInstaller()
    await installCodexHooks(state.tmpProject, { skipGitignore: true })

    const json = JSON.parse(
      readFileSync(join(state.tmpProject, '.codex', 'hooks.json'), 'utf-8')
    ) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> }

    expect(json.hooks.SessionStart).toHaveLength(2)
    const commands = json.hooks.SessionStart.map((g) => g.hooks[0].command)
    expect(commands).toContain('/usr/local/bin/other-hook.sh')
    expect(commands.some((c: string) => c.includes('cc-pewpew'))).toBe(true)
  })

  it('replaces stale cc-pewpew entries on re-install', async () => {
    const { installCodexHooks } = await loadInstaller()
    await installCodexHooks(state.tmpProject, { skipGitignore: true })
    await installCodexHooks(state.tmpProject, { skipGitignore: true })

    const json = JSON.parse(
      readFileSync(join(state.tmpProject, '.codex', 'hooks.json'), 'utf-8')
    ) as { hooks: Record<string, unknown[]> }

    expect(json.hooks.SessionStart).toHaveLength(1)
    expect(json.hooks.Stop).toHaveLength(1)
    expect(json.hooks.PostToolUse).toHaveLength(1)
  })
})

describe('mergeCodexHooksFlag', () => {
  it('inserts [features] table when missing', async () => {
    const { mergeCodexHooksFlag } = await loadInstaller()
    const out = mergeCodexHooksFlag('')
    expect(out).toContain('[features]')
    expect(out).toContain('codex_hooks = true')
  })

  it('inserts codex_hooks key into existing [features] table', async () => {
    const { mergeCodexHooksFlag } = await loadInstaller()
    const input = '[features]\nother_flag = true\n'
    const out = mergeCodexHooksFlag(input)
    expect(out).toContain('other_flag = true')
    expect(out).toContain('codex_hooks = true')
  })

  it('replaces codex_hooks = false with true', async () => {
    const { mergeCodexHooksFlag } = await loadInstaller()
    const input = '[features]\ncodex_hooks = false\n'
    const out = mergeCodexHooksFlag(input)
    expect(out).toContain('codex_hooks = true')
    expect(out).not.toContain('codex_hooks = false')
  })

  it('is idempotent when codex_hooks = true is already set', async () => {
    const { mergeCodexHooksFlag } = await loadInstaller()
    const input = '[features]\ncodex_hooks = true\n'
    const out = mergeCodexHooksFlag(input)
    expect(out).toBe(input)
  })

  it('preserves unrelated tables', async () => {
    const { mergeCodexHooksFlag } = await loadInstaller()
    const input = '[model]\nname = "gpt-5"\n\n[mcp]\nfoo = "bar"\n'
    const out = mergeCodexHooksFlag(input)
    expect(out).toContain('[model]')
    expect(out).toContain('name = "gpt-5"')
    expect(out).toContain('[mcp]')
    expect(out).toContain('foo = "bar"')
    expect(out).toContain('[features]')
    expect(out).toContain('codex_hooks = true')
  })

  it('only matches codex_hooks inside [features], not in other tables', async () => {
    const { mergeCodexHooksFlag } = await loadInstaller()
    const input = '[other]\ncodex_hooks = false\n\n[features]\nfoo = true\n'
    const out = mergeCodexHooksFlag(input)
    // The decoy in [other] must remain untouched
    expect(out).toContain('[other]\ncodex_hooks = false')
    // And [features] must gain codex_hooks = true
    expect(out).toMatch(/\[features\][^[]*codex_hooks = true/)
  })
})

describe('ensureCodexHooksFeatureFlag', () => {
  it('creates ~/.codex/config.toml with [features].codex_hooks = true when missing', async () => {
    const { ensureCodexHooksFeatureFlag } = await loadInstaller()
    ensureCodexHooksFeatureFlag()
    const out = readFileSync(join(state.tmpHome, '.codex', 'config.toml'), 'utf-8')
    expect(out).toContain('[features]')
    expect(out).toContain('codex_hooks = true')
  })

  it('is idempotent', async () => {
    const { ensureCodexHooksFeatureFlag } = await loadInstaller()
    ensureCodexHooksFeatureFlag()
    const first = readFileSync(join(state.tmpHome, '.codex', 'config.toml'), 'utf-8')
    ensureCodexHooksFeatureFlag()
    const second = readFileSync(join(state.tmpHome, '.codex', 'config.toml'), 'utf-8')
    expect(second).toBe(first)
  })

  it('preserves existing config.toml content', async () => {
    mkdirSync(join(state.tmpHome, '.codex'), { recursive: true })
    writeFileSync(
      join(state.tmpHome, '.codex', 'config.toml'),
      '[model]\nname = "gpt-5"\n\n[features]\nother_flag = true\n'
    )

    const { ensureCodexHooksFeatureFlag } = await loadInstaller()
    ensureCodexHooksFeatureFlag()

    const out = readFileSync(join(state.tmpHome, '.codex', 'config.toml'), 'utf-8')
    expect(out).toContain('[model]')
    expect(out).toContain('name = "gpt-5"')
    expect(out).toContain('other_flag = true')
    expect(out).toContain('codex_hooks = true')
  })
})

describe('rollbackCodexHooks', () => {
  it('removes .codex/hooks.json when there was no prior file', async () => {
    const { installCodexHooks, rollbackCodexHooks } = await loadInstaller()
    const snapshot = await installCodexHooks(state.tmpProject, { skipGitignore: true })
    expect(existsSync(join(state.tmpProject, '.codex', 'hooks.json'))).toBe(true)
    rollbackCodexHooks(snapshot)
    expect(existsSync(join(state.tmpProject, '.codex', 'hooks.json'))).toBe(false)
  })

  it('restores the prior file content (preserving unrelated user hooks)', async () => {
    const codexDir = join(state.tmpProject, '.codex')
    mkdirSync(codexDir, { recursive: true })
    const priorJson = JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: '/usr/local/bin/other-hook.sh' }] }],
      },
    })
    writeFileSync(join(codexDir, 'hooks.json'), priorJson)

    const { installCodexHooks, rollbackCodexHooks } = await loadInstaller()
    const snapshot = await installCodexHooks(state.tmpProject, { skipGitignore: true })

    // Pretend the feature-flag step failed; rollback must put the original back.
    rollbackCodexHooks(snapshot)

    const restored = readFileSync(join(state.tmpProject, '.codex', 'hooks.json'), 'utf-8')
    expect(restored).toBe(priorJson)
  })
})
