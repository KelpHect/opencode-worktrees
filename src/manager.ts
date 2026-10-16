import { existsSync, realpathSync } from "node:fs"
import { mkdir, readdir, rmdir } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { resolveBase, type BaseRef } from "./base.js"
import { checkEvaluation, type Isolation } from "./enforce.js"
import { gitOut, type GitRunner } from "./git.js"
import { copyIncluded } from "./include.js"
import { branchFor, isUnder, norm, parseModelRef, worktreeDir, worktreeName, worktreesRoot } from "./paths.js"

export const LOCK_PREFIX = "opencode-worktrees:"
const INDEX_KEY = "wt/index"
const STALE_RUNNING_MS = 5 * 60 * 1000

export type WtStatus = "running" | "kept" | "removed"

export interface WtState {
  sessionID: string
  parent: string
  agent: string
  name: string
  repoRoot: string
  path: string
  branch: string
  baseRef: string
  baseSha: string
  state: WtStatus
  description?: string
  files?: number
  commits?: number
  createdAt: number
  updatedAt: number
}

export interface ModelRef {
  providerID: string
  id: string
  variant?: string
}

export interface SessionLike {
  id: string
  location?: { directory?: string }
  model?: ModelRef
  time?: { updated?: number }
}

export interface ManagerHost {
  git: GitRunner
  storage: {
    get(key: string): Promise<unknown>
    set(key: string, value: any): Promise<void>
    remove(key: string): Promise<void>
  }
  session: {
    get(input: { sessionID: string }): Promise<SessionLike>
    create(input: { parentID: string; agent: string; title?: string; model?: ModelRef }): Promise<{ id: string }>
    move(input: { sessionID: string; directory: string }): Promise<unknown>
  }
  agentModel(agent: string): Promise<ModelRef | undefined>
  isolatedAgents: ReadonlyArray<string>
  now?: () => number
  random?: () => number
  log?: (level: "info" | "warn" | "error", message: string, extra?: unknown) => void
}

export interface SubagentInput {
  agent?: string
  description?: string
  prompt?: string
  sessionID?: string
  model?: string
  background?: boolean
  [key: string]: unknown
}

export interface WorktreeEntry {
  path: string
  branch?: string
  locked?: string | true
}

export function parseWorktreeList(porcelain: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = []
  let current: WorktreeEntry | undefined
  for (const line of porcelain.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) entries.push((current = { path: line.slice(9).trim() }))
    else if (current && line.startsWith("branch ")) current.branch = line.slice(7).trim()
    else if (current && line.startsWith("locked")) current.locked = line.slice(6).trim() || true
  }
  return entries
}

export function decideClean(porcelain: string, commitsAhead: number): { clean: boolean; files: number } {
  const files = porcelain.split(/\r?\n/).filter((l) => l.trim()).length
  return { clean: files === 0 && commitsAhead === 0, files }
}

export function mainCheckoutFromCommonDir(commonDir: string): string | undefined {
  const normalized = commonDir.replace(/[\\/]+$/, "")
  return basename(normalized) === ".git" ? dirname(normalized) : undefined
}

export function isolationNote(state: WtState, newSession: boolean): string {
  return [
    newSession ? "You are a subagent spawned by another session." : undefined,
    "",
    "[Worktree isolation] You are running in your own temporary git worktree.",
    `- Worktree path: ${state.path}`,
    `- Branch: ${state.branch} (created from ${state.baseRef} @ ${state.baseSha.slice(0, 8)})`,
    `- Work and run commands only inside this path. The main checkout at ${state.repoRoot} is off limits: edits and git commands against it are refused.`,
    "- When you are done, commit your work on this branch (git add -A && git commit). If you change nothing, the worktree is removed automatically.",
    `- End your report with the branch name (${state.branch}) and a one-line \`git diff --stat ${state.baseSha.slice(0, 8)}..HEAD\` summary.`,
    "",
    "Task:",
    "",
  ]
    .filter((line) => line !== undefined)
    .join("\n")
}

export function statusLine(state: WtState): string {
  const head = `[worktree] session ${state.sessionID} (${state.agent}) — ${state.path}, branch ${state.branch}, base ${state.baseRef}@${state.baseSha.slice(0, 8)}:`
  switch (state.state) {
    case "running":
      return `${head} running`
    case "removed":
      return `${head} finished clean, worktree and branch removed`
    case "kept":
      return `${head} kept — ${state.files ?? 0} changed file(s), ${state.commits ?? 0} commit(s) ahead of base`
  }
}

export class WorktreeManager {
  private readonly states = new Map<string, WtState>()
  private readonly locks = new Map<string, Promise<unknown>>()
  private readonly failedFetches = new Map<string, number>()
  /** Continuations prepared whose execution has not started yet; late finish events from the previous turn must not act on them. */
  private readonly awaitingStart = new Set<string>()
  private loaded = false

  constructor(private readonly host: ManagerHost) {}

  private now() {
    return (this.host.now ?? Date.now)()
  }

  private log(level: "info" | "warn" | "error", message: string, extra?: unknown) {
    this.host.log?.(level, message, extra)
  }

  private serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(fn)
    this.locks.set(key, next)
    void next.catch(() => undefined).finally(() => {
      if (this.locks.get(key) === next) this.locks.delete(key)
    })
    return next
  }

  async load() {
    if (this.loaded) return
    this.loaded = true
    const index = ((await this.host.storage.get(INDEX_KEY)) as string[] | undefined) ?? []
    for (const id of index) {
      const state = (await this.host.storage.get(`wt/${id}`)) as WtState | undefined
      if (state) this.states.set(id, state)
    }
  }

  private async save(state: WtState) {
    state.updatedAt = this.now()
    this.states.set(state.sessionID, state)
    await this.host.storage.set(`wt/${state.sessionID}`, state)
    await this.host.storage.set(INDEX_KEY, [...this.states.keys()])
  }

  isIsolated(agent: string | undefined): boolean {
    return agent !== undefined && this.host.isolatedAgents.includes(agent)
  }

  get(sessionID: string): WtState | undefined {
    return this.states.get(sessionID)
  }

  childrenOf(parent: string): WtState[] {
    return [...this.states.values()].filter((s) => s.parent === parent).sort((a, b) => a.createdAt - b.createdAt)
  }

  isolationFor(sessionID: string): Isolation | undefined {
    const state = this.states.get(sessionID)
    if (!state || state.state === "removed") return undefined
    return { mainRoot: state.repoRoot, worktree: state.path, branch: state.branch }
  }

  /** Isolation that applies to a shell started in `cwd`, identified by the worktree it sits in. */
  isolationForCwd(cwd: string): Isolation | undefined {
    const key = norm(cwd)
    for (const state of this.states.values()) {
      if (state.state === "removed") continue
      const root = norm(state.path)
      if (key === root || key.startsWith(root + "/")) return { mainRoot: state.repoRoot, worktree: state.path, branch: state.branch }
    }
    return undefined
  }

  checkEvaluation(sessionID: string, evaluation: { action: string; resources: ReadonlyArray<string> }): string | undefined {
    const iso = this.isolationFor(sessionID)
    return iso ? checkEvaluation(evaluation, iso) : undefined
  }

  // ---- git helpers ----

  private async mainRootFor(directory: string): Promise<string> {
    const result = await this.host.git(directory, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
    if (result.code !== 0) throw new Error("worker requires a git repository; use general instead")
    const root = mainCheckoutFromCommonDir(result.stdout.trim())
    if (!root) throw new Error("worker requires a non-bare git repository with a main checkout; use general instead")
    const real = existsSync(root) ? realpathSync.native(root) : root
    return isUnder(directory, real) ? directory.slice(0, real.length) : real
  }

  private async branchExists(repo: string, branch: string) {
    return (await this.host.git(repo, ["show-ref", "--verify", "-q", `refs/heads/${branch}`])).code === 0
  }

  private async addWorktree(state: Pick<WtState, "repoRoot" | "path" | "branch" | "baseSha">) {
    await mkdir(dirname(state.path), { recursive: true })
    const exists = await this.branchExists(state.repoRoot, state.branch)
    const args = exists ? ["worktree", "add", state.path, state.branch] : ["worktree", "add", "-b", state.branch, state.path, state.baseSha]
    await gitOut(this.host.git, state.repoRoot, args)
    await copyIncluded(this.host.git, state.repoRoot, state.path).catch((error) => this.log("warn", "worktreeinclude copy failed", error))
  }

  private async lock(state: WtState) {
    const result = await this.host.git(state.repoRoot, ["worktree", "lock", "--reason", `${LOCK_PREFIX}${state.sessionID}`, state.path])
    if (result.code !== 0 && !/already locked/i.test(result.stderr)) this.log("warn", "worktree lock failed", result.stderr.trim())
  }

  private async lockedEntry(state: WtState): Promise<WorktreeEntry | undefined> {
    const out = await this.host.git(state.repoRoot, ["worktree", "list", "--porcelain"])
    return parseWorktreeList(out.stdout).find((entry) => norm(entry.path) === norm(state.path))
  }

  /** Unlocks only locks this plugin set for this session. */
  private async unlockOurs(state: WtState) {
    const entry = await this.lockedEntry(state)
    if (!entry || !entry.locked) return
    if (typeof entry.locked === "string" && entry.locked === `${LOCK_PREFIX}${state.sessionID}`) {
      await this.host.git(state.repoRoot, ["worktree", "unlock", state.path])
    }
  }

  // ---- lifecycle ----

  /** Called from execute.before on the subagent tool; returns the input to execute, or undefined to leave it alone. */
  async prepare(callerSessionID: string, input: SubagentInput): Promise<SubagentInput | undefined> {
    await this.load()
    if (!this.isIsolated(input.agent)) return undefined
    if (input.sessionID) return this.prepareContinuation(callerSessionID, input)
    return this.prepareNew(callerSessionID, input)
  }

  private async prepareNew(callerSessionID: string, input: SubagentInput): Promise<SubagentInput> {
    const agent = input.agent!
    const parent = await this.host.session.get({ sessionID: callerSessionID })
    const directory = parent.location?.directory
    if (!directory) throw new Error("could not determine the calling session's directory")
    const repoRoot = await this.mainRootFor(directory)
    const base = await resolveBase(repoRoot, { git: this.host.git, now: this.host.now, failedAttempts: this.failedFetches })

    let name = ""
    for (let attempt = 0; attempt < 20; attempt++) {
      name = worktreeName(agent, this.host.random)
      if (!existsSync(worktreeDir(repoRoot, name)) && !(await this.branchExists(repoRoot, branchFor(name)))) break
      if (attempt === 19) throw new Error("could not allocate a unique worktree name")
    }
    const state: WtState = {
      sessionID: "",
      parent: callerSessionID,
      agent,
      name,
      repoRoot,
      path: worktreeDir(repoRoot, name),
      branch: branchFor(name),
      baseRef: base.ref,
      baseSha: base.sha,
      state: "running",
      description: input.description,
      createdAt: this.now(),
      updatedAt: this.now(),
    }
    await this.addWorktree(state)
    try {
      const model = (input.model ? parseModelRef(input.model) : undefined) ?? (await this.host.agentModel(agent)) ?? parent.model
      const child = await this.host.session.create({ parentID: callerSessionID, agent, title: input.description, ...(model ? { model } : {}) })
      state.sessionID = child.id
      await this.save(state)
      await this.lock(state)
      await this.host.session.move({ sessionID: child.id, directory: state.path })
    } catch (error) {
      await this.discard(state)
      throw error
    }
    this.log("info", `created worktree ${state.path} (${state.branch}) from ${base.ref}@${base.sha.slice(0, 8)} [${base.fetch}] for ${state.sessionID}`)
    const { model: _model, ...rest } = input
    return { ...rest, sessionID: state.sessionID, prompt: isolationNote(state, true) + (input.prompt ?? "") }
  }

  private async prepareContinuation(callerSessionID: string, input: SubagentInput): Promise<SubagentInput | undefined> {
    const state = this.states.get(input.sessionID!)
    if (!state || state.parent !== callerSessionID) return undefined
    return this.serial(state.sessionID, async () => {
      if (!existsSync(state.path) || !(await this.isRegistered(state))) {
        await this.addWorktree(state)
        await this.host.session.move({ sessionID: state.sessionID, directory: state.path })
        this.log("info", `recreated worktree ${state.path} (${state.branch}) for ${state.sessionID}`)
      }
      state.state = "running"
      this.awaitingStart.add(state.sessionID)
      await this.save(state)
      await this.lock(state)
      return { ...input, prompt: isolationNote(state, false) + (input.prompt ?? "") }
    })
  }

  private async discard(state: WtState) {
    await this.host.git(state.repoRoot, ["worktree", "remove", "--force", state.path])
    await this.host.git(state.repoRoot, ["branch", "-D", state.branch])
    if (state.sessionID) {
      this.states.delete(state.sessionID)
      await this.host.storage.remove(`wt/${state.sessionID}`)
      await this.host.storage.set(INDEX_KEY, [...this.states.keys()])
    }
  }

  async onStarted(sessionID: string) {
    const state = this.states.get(sessionID)
    if (!state) return
    await this.serial(sessionID, async () => {
      this.awaitingStart.delete(sessionID)
      if (state.state === "removed" || !existsSync(state.path) || !(await this.isRegistered(state))) return
      if (state.state !== "running") {
        state.state = "running"
        await this.save(state)
        await this.lock(state)
      }
    })
  }

  /** Removes an empty, unregistered leftover directory, retrying while something still holds it open. */
  async removeLeftover(path: string, attempts = 12, delayMs = 5000) {
    for (let i = 0; i < attempts; i++) {
      try {
        if (!existsSync(path)) return
        if ((await readdir(path)).length > 0) return
        await rmdir(path)
        return
      } catch {
        await new Promise((resolve) => setTimeout(resolve, delayMs))
      }
    }
    this.log("warn", `could not remove leftover directory ${path}`)
  }

  private async isRegistered(state: WtState): Promise<boolean> {
    return (await this.lockedEntry(state)) !== undefined
  }

  /** Idempotent: only acts while the record says running. `force` is for callers that know the turn has ended. */
  finish(sessionID: string, options: { force?: boolean } = {}): Promise<WtState | undefined> {
    const state = this.states.get(sessionID)
    if (!state) return Promise.resolve(undefined)
    return this.serial(sessionID, async () => {
      if (state.state !== "running") return state
      if (this.awaitingStart.has(sessionID)) {
        if (!options.force) return state
        this.awaitingStart.delete(sessionID)
      }
      await this.unlockOurs(state)
      if (!existsSync(state.path) || !(await this.isRegistered(state))) {
        state.state = "removed"
        await this.save(state)
        return state
      }
      const status = await this.host.git(state.path, ["status", "--porcelain", "--untracked-files=all"])
      const ahead = await this.host.git(state.path, ["rev-list", "--count", `${state.baseSha}..HEAD`])
      if (status.code !== 0 || ahead.code !== 0) {
        this.log("warn", `could not inspect ${state.path}; keeping it`, (status.stderr || ahead.stderr).trim())
        state.state = "kept"
        await this.save(state)
        return state
      }
      const verdict = decideClean(status.stdout, Number.parseInt(ahead.stdout.trim(), 10) || 0)
      if (verdict.clean) {
        const removed = await this.host.git(state.repoRoot, ["worktree", "remove", "--force", state.path])
        // On Windows git can deregister the worktree yet fail to delete the directory itself while the
        // server still holds a handle on it; the (empty) leftover directory is cleaned up afterwards.
        if (removed.code === 0 || !(await this.lockedEntry(state))) {
          await this.host.git(state.repoRoot, ["branch", "-D", state.branch])
          state.state = "removed"
          void this.removeLeftover(state.path)
        } else {
          this.log("warn", `worktree remove failed for ${state.path}; keeping it`, removed.stderr.trim())
          state.state = "kept"
        }
      } else state.state = "kept"
      state.files = verdict.files
      state.commits = Number.parseInt(ahead.stdout.trim(), 10) || 0
      await this.save(state)
      return state
    })
  }

  private async sweepLeftovers() {
    const roots = new Set([...this.states.values()].map((s) => s.repoRoot))
    for (const repo of roots) {
      const dir = worktreesRoot(repo)
      const names = await readdir(dir).catch(() => [] as string[])
      if (names.length === 0) continue
      const listed = parseWorktreeList((await this.host.git(repo, ["worktree", "list", "--porcelain"])).stdout).map((e) => norm(e.path))
      for (const name of names) {
        const full = join(dir, name)
        if (listed.includes(norm(full))) continue
        if ((await readdir(full).catch(() => ["?"])).length === 0) await rmdir(full).catch(() => undefined)
      }
    }
  }

  /** Releases our stale locks and removes clean worktrees whose sessions are no longer active. */
  async sweep() {
    await this.load()
    await this.sweepLeftovers().catch((error) => this.log("warn", "leftover sweep failed", error))
    for (const state of [...this.states.values()]) {
      try {
        if (state.state === "running") {
          const session = await this.host.session.get({ sessionID: state.sessionID }).catch(() => undefined)
          const updated = session?.time?.updated ?? 0
          if (session && this.now() - updated < STALE_RUNNING_MS) continue
          await this.finish(state.sessionID)
        } else if (state.state === "kept") {
          await this.serial(state.sessionID, () => this.unlockOurs(state))
        }
        const latest = this.states.get(state.sessionID)
        if (latest?.state === "kept") this.log("info", `kept worktree with work: ${latest.path} (${latest.branch}, ${latest.files ?? 0} files, ${latest.commits ?? 0} commits)`)
      } catch (error) {
        this.log("warn", `sweep failed for ${state.sessionID}`, error)
      }
    }
  }

  // ---- reporting to the parent ----

  contextText(sessionID: string): string | undefined {
    const children = this.childrenOf(sessionID)
    if (children.length === 0) return undefined
    return [
      "Isolated subagent worktrees created from this session:",
      ...children.slice(-30).map(statusLine),
      "To integrate a kept worktree: run `git merge <branch>` from the main checkout, then clean up with `git worktree remove <path>` and `git branch -d <branch>`.",
    ].join("\n")
  }
}

export { type BaseRef }
