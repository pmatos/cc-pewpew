# Plan: Remote Sessions End-to-End

> Source issue: [pmatos/pewpew#11](https://github.com/pmatos/pewpew/issues/11)  
> Parent PRD: [pmatos/pewpew#8](https://github.com/pmatos/pewpew/issues/8)  
> Prerequisite: [pmatos/pewpew#10](https://github.com/pmatos/pewpew/issues/10) is closed and its remote-project registry/UI work is present on `origin/main`.

## Current Baseline

- `Project.hostId` and the remote project registry are present. `src/main/remote-project-registry.ts` maps remote projects into sidebar `Project` records with empty local worktree data.
- `Session` does not yet persist `hostId` or connection state. All creation, revive, restore, kill, thumbnail, and review paths assume local filesystem + local `tmux`.
- `src/main/host-connection.ts` is a stateless SSH helper for host tests and remote repo validation. It does not yet maintain a ControlMaster, reverse tunnel, persistent state, or PTY attach process.
- `src/main/hook-server.ts` listens on one local socket only and dispatches events without origin tagging.
- `src/main/hook-installer.ts` installs local hooks into a local worktree and references a local `notify.sh`.
- Renderer session cards already have chip/pill styling patterns, but session cards and detail view do not know host labels or remote connection state.

## Architectural Decisions

- **Session host identity**: Add `Session.hostId: string | null`. Missing legacy values load as `null`. Remote sessions inherit host identity from the selected project.
- **Connection state**: Add a narrow session-visible connection state, separate from Claude activity status: `pending | live | offline | auth-failed | unreachable`. Local sessions can report `live` while active and do not show remote-only recovery UI.
- **HostConnection owner**: Keep all SSH process shape inside `HostConnection`. Callers ask for `ensureLive(hostId)`, `exec(hostId, argv, opts)`, `spawnAttach(hostId, argv, opts)`, and `release(hostId)`.
- **Control connection lifetime**: Open lazily on first remote session use, retain while sessions reference the host, and release on app quit or when the last live session for that host is torn down.
- **Remote shell safety**: Preserve the current invariant that user paths are argv entries, not string-concatenated shell snippets. Any unavoidable `sh -c` script receives paths through positional parameters.
- **Hook origin boundary**: Refactor the hook server around origin sockets. Every accepted event is tagged with `originHostId`, and session events are dropped if their matched session has a different `hostId`.
- **Remote bootstrap**: New `HostBootstrap` module performs dependency checks, StreamLocalBindUnlink validation, versioned notify script install, and remote breadcrumb install before creating the first remote session on a host.
- **Review remains local-only**: For issue 11, disable review UI/actions for remote sessions with a clear disabled state. Remote git diff/list-branch handlers stay out of scope.

## Phase 1: Shared Model and Host Lookup

### What to build

Extend shared types and session manager plumbing so local and remote sessions can be represented without changing behavior yet. Add helpers to resolve a project path to either a local project or a persisted remote project/host pair. Make all old persisted sessions load as local.

### Acceptance criteria

- [ ] `Session.hostId: string | null` is defined in `src/shared/types.ts`.
- [ ] `Session.connectionState` or equivalent remote-state field is defined without overloading `SessionStatus`.
- [ ] `restoreSessions()` backfills missing `hostId` as `null`.
- [ ] `createSession()` can resolve remote project metadata by `(hostId, projectPath)` while preserving the existing local call shape from the renderer.
- [ ] Host deletion protection in `host-registry.ts` becomes active for newly persisted remote sessions.
- [ ] Local session creation, restore, revive, kill, and remove behavior remains unchanged.

## Phase 2: Persistent HostConnection

### What to build

Turn `HostConnection` from standalone functions into a process-owning manager while retaining the existing `testConnection()` and `validateRemoteRepo()` behavior. Introduce ControlPath and per-host IPC socket path allocation under `CONFIG_DIR`.

### Acceptance criteria

- [ ] `HostConnection.ensureLive(host)` starts `ssh -N` with `ControlMaster=yes`, `ControlPersist=10m`, `ExitOnForwardFailure=yes`, keepalives, and `-R /tmp/pewpew-{uid}.sock:<local ipc-host socket>`.
- [ ] Repeated `ensureLive()` calls for the same host reuse the in-flight/live connection.
- [ ] `exec(host, argv)` multiplexes through the host's ControlPath and preserves argv quoting.
- [ ] `spawnAttach(host, argv)` returns a child suitable for `node-pty` bridging via local `ssh ... tmux attach-session ...`.
- [ ] SSH failures are classified through the existing exit parser and surfaced as typed errors.
- [ ] `release(hostId)` tears down only when no session still references the host.
- [ ] Existing `testConnection()` and `validateRemoteRepo()` tests still pass.

## Phase 3: Multi-Origin HookIpcServer

### What to build

Replace the single module-level hook server with a multi-socket server that owns the local socket plus one socket per connected host. Route origin-tagged events into session-manager validation before broadcasting.

### Acceptance criteria

- [ ] The existing local `ipc.sock` and `socket-path` breadcrumb still work for local sessions.
- [ ] `listenHost(hostId)` creates/listens on `ipc-{hostId}.sock` and returns the socket path used by `HostConnection`.
- [ ] Every dispatched hook event includes `originHostId: string | null`.
- [ ] `handleHookEvent()` receives origin and rejects mismatched-origin session events.
- [ ] Mismatch drops are logged with session id, expected host, and origin host.
- [ ] Unit tests use real Unix sockets in temp directories for local and host origins.
- [ ] Local hook behavior remains unchanged end-to-end.

## Phase 4: Remote Bootstrap

### What to build

Add `src/main/host-bootstrap.ts` as a deterministic orchestration module around a minimal connection interface. Bootstrap checks remote dependencies and installs the versioned hook artifacts.

### Acceptance criteria

- [ ] Probes `tmux`, `git`, `jq`, `socat`, and `claude` on the remote PATH.
- [ ] Checks whether sshd supports the required StreamLocalBindUnlink behavior for the reverse Unix socket.
- [ ] Installs `~/.config/pewpew/hooks/notify-v1.sh` if absent or wrong version.
- [ ] Writes a remote breadcrumb pointing at `/tmp/pewpew-{uid}.sock`.
- [ ] Returns typed, actionable errors for missing deps and StreamLocalBindUnlink failure.
- [ ] Caches successful bootstrap per host per app session.
- [ ] Unit tests cover all-deps-present, selective missing dependency, and already-installed script cases with fake exec responses.

## Phase 5: Remote Session Creation and PTY Attach

### What to build

Branch session creation on `hostId`. For remote projects, create the worktree and tmux session on the remote host, install per-worktree hooks pointing at the versioned remote notify script, and attach via SSH-backed PTY.

### Acceptance criteria

- [ ] Remote `git worktree add` runs on the remote host under `{projectPath}/.claude/worktrees/{worktreeName}`.
- [ ] Remote branch fallback mirrors local behavior: try `-b pewpew/{worktreeName}`, then retry without `-b`.
- [ ] Remote hook config is installed into `{worktreePath}/.claude/settings.local.json`.
- [ ] The hook command uses the absolute remote `notify-v1.sh` path.
- [ ] Remote tmux creation runs `tmux new-session -d -s pewpew-{id} -c {worktreePath} claude --dangerously-skip-permissions`.
- [ ] Remote attach streams into the existing renderer terminal data path.
- [ ] Missing dependency/bootstrap errors block creation and surface a specific message.
- [ ] Concurrent sessions on the same remote project get independent worktree hook files.

## Phase 6: Remote Session Lifecycle

### What to build

Make kill, revive, remove, restore, thumbnails, and cleanup respect host identity. Keep v1 lazy: app startup does not connect to remote hosts automatically.

### Acceptance criteria

- [ ] `restoreSessions()` materializes remote sessions without opening SSH connections.
- [ ] Restored remote sessions show a non-live state until user-initiated open/revive.
- [ ] Opening/reviving a remote session ensures host connection, probes tmux, and attaches or recreates with `claude --continue`.
- [ ] Killing a remote session detaches PTY and kills the remote tmux session, leaving the remote worktree intact.
- [ ] Removing a remote session removes the remote worktree only when the current remove-worktree action is requested.
- [ ] Thumbnail capture includes remote sessions via `tmux capture-pane` over the multiplexed connection.
- [ ] App quit releases host connections and stops all origin sockets.
- [ ] Local lifecycle behavior remains unchanged.

## Phase 7: Renderer Host and Connection UI

### What to build

Surface host identity and connection state in the canvas and detail view using the existing host registry store and current visual language.

### Acceptance criteria

- [ ] Session card thumbnail shows a bottom-left host pill for remote sessions only.
- [ ] Session card shows a connection-status dot for remote sessions that reflects `pending`, `live`, `offline`, `auth-failed`, or `unreachable`.
- [ ] Detail pane header/status area shows host label plus connection state.
- [ ] Dead/unreachable remote sessions show a reconnect/restart action that calls the existing revive/open path.
- [ ] Review overlay entry is disabled for remote sessions with a concise "coming soon" state.
- [ ] Local session cards do not gain extra host noise.

## Phase 8: Tests and Validation

### What to build

Land tests around the new deep modules and run the existing compile/test suite. Use CDP smoke testing only if the UI changes go beyond static rendering or interaction states.

### Acceptance criteria

- [ ] `src/main/host-bootstrap.test.ts` covers dependency and install scenarios with fake connection responses.
- [ ] `src/main/hook-server.test.ts` covers multi-origin listening, origin tagging, invalid JSON response handling, and host mismatch rejection.
- [ ] Existing host validation and remote project tests pass.
- [ ] `npm run type-check` passes.
- [ ] `npx vitest run` passes, or any failures are documented as pre-existing and unrelated.
- [ ] Manual smoke: create a local session to confirm unchanged behavior.
- [ ] Manual remote smoke with a configured SSH alias: add/use remote project, create session, see terminal output, receive hook state, kill session.

## Suggested Implementation Order

1. Model fields and compatibility loaders.
2. `HostConnection` manager shape with tests around command argv/control path construction.
3. `HookIpcServer` refactor plus socket tests.
4. `HostBootstrap` and remote notify script rendering.
5. Remote branches in `session-manager` and `pty-manager`.
6. Thumbnail/lifecycle cleanup.
7. Renderer host/status affordances.
8. Full validation pass.

## Known Risks

- The current `pty-manager` stores only `node-pty` entries and local tmux names. Remote PTY entries need enough host metadata to kill/capture/reattach the right tmux session.
- `handleHookEvent()` currently matches primarily by `cwd.startsWith(worktreePath)`. That remains useful for remote events, but origin validation must run after matching and before mutation.
- `spawnAttach()` with `node-pty` will run a local `ssh` process, not a local tmux process. Resize/write paths should continue to work, but exit classification needs to account for SSH termination.
- `removeSession()` currently calls both `destroyPty()` and `removeWorktree()`, and `promptCleanup()` may call `removeSession()` after already removing the worktree. Remote implementation should avoid double remote calls where possible.
- The remote review pane is out of scope; all renderer entry points that open review need a remote guard.
