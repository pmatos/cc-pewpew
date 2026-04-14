import { readdirSync, existsSync, readFileSync, statSync, lstatSync, realpathSync } from 'fs'
import { join, basename } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import type { Project, Worktree } from '../shared/types'

const execFileAsync = promisify(execFile)

async function gitBranches(repoPath: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', repoPath, 'branch', '--list'], {
      timeout: 5000,
    })
    return stdout
      .split('\n')
      .map((line) => line.replace(/^\*?\s+/, '').trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

async function gitWorktrees(repoPath: string): Promise<Worktree[]> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', repoPath, 'worktree', 'list', '--porcelain'],
      { timeout: 5000 }
    )

    const worktrees: Worktree[] = []
    const blocks = stdout.split('\n\n').filter(Boolean)

    for (const block of blocks) {
      const lines = block.split('\n')
      let path = ''
      let branch = ''

      for (const line of lines) {
        if (line.startsWith('worktree ')) {
          path = line.slice('worktree '.length)
        } else if (line.startsWith('branch ')) {
          branch = line.slice('branch refs/heads/'.length)
        }
      }

      if (path) {
        worktrees.push({
          name: basename(path),
          path,
          branch: branch || 'HEAD',
        })
      }
    }

    return worktrees
  } catch {
    return []
  }
}

function detectSetupState(repoPath: string): 'ready' | 'unsetup' {
  const settingsPath = join(repoPath, '.claude', 'settings.local.json')
  if (!existsSync(settingsPath)) return 'unsetup'

  try {
    const raw = readFileSync(settingsPath, 'utf-8')
    const content = JSON.stringify(JSON.parse(raw))
    return content.includes('cc-pewpew') ? 'ready' : 'unsetup'
  } catch {
    return 'unsetup'
  }
}

function discoverRepos(
  scanDirs: string[],
  pinnedPaths: string[],
  followSymlinks: boolean
): { name: string; path: string }[] {
  const repos: { name: string; path: string }[] = []
  const seen = new Set<string>()

  for (const dir of scanDirs) {
    if (!existsSync(dir)) continue

    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }

    for (const entry of entries) {
      const entryPath = join(dir, entry)
      try {
        if (!followSymlinks && lstatSync(entryPath).isSymbolicLink()) continue
        if (!statSync(entryPath).isDirectory()) continue
      } catch {
        continue
      }
      if (!existsSync(join(entryPath, '.git'))) continue
      const realPath = followSymlinks ? realpathSync(entryPath) : entryPath
      if (seen.has(realPath)) continue
      repos.push({ name: entry, path: entryPath })
      seen.add(realPath)
    }
  }

  for (const pinned of pinnedPaths) {
    const realPinned = followSymlinks ? realpathSync(pinned) : pinned
    if (seen.has(realPinned)) continue
    try {
      if (!followSymlinks && lstatSync(pinned).isSymbolicLink()) continue
      if (!statSync(pinned).isDirectory()) continue
    } catch {
      continue
    }
    if (!existsSync(join(pinned, '.git'))) continue
    repos.push({ name: basename(pinned), path: pinned })
    seen.add(realPinned)
  }

  return repos.sort((a, b) => a.name.localeCompare(b.name))
}

async function enrichRepo(repo: { name: string; path: string }): Promise<Project> {
  const [branches, worktrees] = await Promise.all([gitBranches(repo.path), gitWorktrees(repo.path)])

  return {
    name: repo.name,
    path: repo.path,
    branches,
    worktrees,
    setupState: detectSetupState(repo.path),
  }
}

const CONCURRENCY = 10

export async function getRepoFingerprint(repoPath: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', repoPath, 'rev-list', '--max-parents=0', 'HEAD'],
      { timeout: 5000 }
    )
    const firstLine = stdout.trim().split('\n')[0]
    return firstLine || undefined
  } catch {
    return undefined
  }
}

export async function scanProjects(
  scanDirs: string[],
  pinnedPaths?: string[],
  followSymlinks?: boolean
): Promise<Project[]> {
  const repos = discoverRepos(scanDirs, pinnedPaths || [], followSymlinks ?? true)
  const projects: Project[] = []

  // Process in batches to avoid spawning hundreds of git processes
  for (let i = 0; i < repos.length; i += CONCURRENCY) {
    const batch = repos.slice(i, i + CONCURRENCY)
    const results = await Promise.all(batch.map(enrichRepo))
    projects.push(...results)
  }

  return projects.sort((a, b) => a.name.localeCompare(b.name))
}
