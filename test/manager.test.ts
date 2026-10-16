import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { runGit } from "../src/git.js"
import {
  LOCK_PREFIX,
  WorktreeManager,
  decideClean,
  mainCheckoutFromCommonDir,
  parseWorktreeList,
  statusLine,
  type ManagerHost,
} from "../src/manager.js"
import { git, makeFixture, tempDir } from "./helpers.js"

function setup(directoryOverride?: string) {
  const f = makeFixture()
  const store = new Map<string, any>()
  const created: any[] = []
  const moves: Array<{ sessionID: string; directory: string }> = []
  let n = 0
  const host: ManagerHost = {
    git: runGit,
    storage: {
      get: async (k) => store.get(k),
      set: async (k, v) => void store.set(k, JSON.parse(JSON.stringify(v))),
      remove: async (k) => void store.delete(k),
    },
    session: {
      get: async (i) => ({ id: i.sessionID, location: { directory: directoryOverride ?? f.repo }, model: { providerID: "p", id: "parent-model" }, time: { updated: Date.now() } }),
      create: async (i) => (created.push(i), { id: `ses_child${++n}` }),
      move: async (i) => void moves.push(i),
    },
    agentModel: async (agent) => (agent === "worker" ? { providerID: "opencode-go", id: "agent-model" } : undefined),
    isolatedAgents: ["worker"],
    random: (() => {
      let i = 0
      return () => ((i += 0.137) % 1)
    })(),
  }
  const manager = new WorktreeManager(host)
  return { f, store, created, moves, host, manager }
}

const lockOf = (repo: string, path: string) => parseWorktreeList(git(repo, "worktree", "list", "--porcelain")).find((e) => e.path.toLowerCase().endsWith(path.replace(/\\/g, "/").split("/").pop()!.toLowerCase()))

describe("pure helpers", () => {
  test("clean vs dirty decision", () => {
    expect(decideClean("", 0)).toEqual({ clean: true, files: 0 })
    expect(decideClean("?? new.txt\n M a.txt\n", 0)).toEqual({ clean: false, files: 2 })
    expect(decideClean("", 2)).toEqual({ clean: false, files: 0 })
  })
  test("main checkout from common dir", () => {
    expect(mainCheckoutFromCommonDir("C:/work/repo/.git")).toBe("C:/work/repo")
    expect(mainCheckoutFromCommonDir("C:/work/bare.git")).toBeUndefined()
  })
  test("porcelain parsing keeps lock reasons", () => {
    const out = "worktree /a\nHEAD x\nbranch refs/heads/main\n\nworktree /b\nHEAD y\nbranch refs/heads/wb\nlocked opencode-worktrees:ses_1\n\nworktree /c\nlocked\n"
    const list = parseWorktreeList(out)
    expect(list[0].locked).toBeUndefined()
    expect(list[1].locked).toBe("opencode-worktrees:ses_1")
    expect(list[2].locked).toBe(true)
  })
})

describe("prepare (new isolated subagent)", () => {
  test("creates worktree next to repo from origin's default branch, locks, moves, rewrites input", async () => {
    const t = setup()
    const out = await t.manager.prepare("ses_parent", { agent: "worker", description: "do it", prompt: "TASK", model: "opencode-go/step-5-preview#fast" })
    const state = t.manager.get("ses_child1")!
    expect(state.path.toLowerCase()).toBe(join(t.f.root, "proj.worktrees", state.name).toLowerCase())
    expect(state.name).toMatch(/^worker-[a-z0-9]{6}$/)
    expect(state.branch).toBe(`worktree-${state.name}`)
    expect(state.baseSha).toBe(t.f.c2)
    expect(state.baseRef).toBe("origin/main")
    expect(git(state.path, "rev-parse", "HEAD")).toBe(t.f.c2)
    expect(existsSync(join(state.path, "c3.txt"))).toBe(false)
    expect(lockOf(t.f.repo, state.path)?.locked).toBe(`${LOCK_PREFIX}ses_child1`)
    expect(t.created[0]).toMatchObject({ parentID: "ses_parent", agent: "worker", title: "do it", model: { providerID: "opencode-go", id: "step-5-preview", variant: "fast" } })
    expect(t.moves).toEqual([{ sessionID: "ses_child1", directory: state.path }])
    expect(out).toMatchObject({ agent: "worker", sessionID: "ses_child1" })
    expect(out!.model).toBeUndefined()
    expect(out!.prompt).toStartWith("You are a subagent spawned by another session.")
    expect(out!.prompt).toContain(state.path)
    expect(out!.prompt).toContain("staging only the files you changed")
    expect(out!.prompt).not.toContain("git add -A &&")
    expect(out!.prompt).toEndWith("TASK")
    expect(t.store.get("wt/ses_child1").repoRoot).toBe(state.repoRoot)
    expect(t.store.get("wt/index")).toEqual(["ses_child1"])
  })

  test("model precedence: explicit > agent config > parent", async () => {
    const t = setup()
    await t.manager.prepare("p", { agent: "worker", prompt: "x" })
    expect(t.created[0].model).toEqual({ providerID: "opencode-go", id: "agent-model" })
    const t2 = setup()
    t2.host.agentModel = async () => undefined
    await new WorktreeManager(t2.host).prepare("p", { agent: "worker", prompt: "x" })
    expect(t2.created[0].model).toEqual({ providerID: "p", id: "parent-model" })
  })

  test("non-isolated agents and foreign continuations are left alone", async () => {
    const t = setup()
    expect(await t.manager.prepare("p", { agent: "general", prompt: "x" })).toBeUndefined()
    expect(await t.manager.prepare("p", { agent: "worker", sessionID: "ses_unknown", prompt: "x" })).toBeUndefined()
    expect(t.created).toHaveLength(0)
  })

  test("fails clearly outside a git repository", async () => {
    const t = setup(tempDir("not-git-"))
    await expect(t.manager.prepare("p", { agent: "worker", prompt: "x" })).rejects.toThrow("worker requires a git repository; use general instead")
  })

  test("session creation failure rolls the worktree back", async () => {
    const t = setup()
    t.host.session.create = async () => {
      throw new Error("nope")
    }
    await expect(t.manager.prepare("p", { agent: "worker", prompt: "x" })).rejects.toThrow("nope")
    expect(git(t.f.repo, "worktree", "list").split("\n")).toHaveLength(1)
    expect(git(t.f.repo, "branch", "--list", "worktree-*")).toBe("")
  })

  test("copies .worktreeinclude files", async () => {
    const t = setup()
    writeFileSync(join(t.f.repo, ".env.local"), "S=1")
    writeFileSync(join(t.f.repo, ".worktreeinclude"), ".env.local\n")
    await t.manager.prepare("p", { agent: "worker", prompt: "x" })
    expect(existsSync(join(t.manager.get("ses_child1")!.path, ".env.local"))).toBe(true)
  })

  test("two parallel workers get distinct worktrees and branches", async () => {
    const t = setup()
    await Promise.all([t.manager.prepare("p", { agent: "worker", prompt: "a" }), t.manager.prepare("p", { agent: "worker", prompt: "b" })])
    const [a, b] = [t.manager.get("ses_child1")!, t.manager.get("ses_child2")!]
    expect(a.path).not.toBe(b.path)
    expect(a.branch).not.toBe(b.branch)
    expect(t.manager.childrenOf("p")).toHaveLength(2)
  })
})

describe("finish", () => {
  test("clean worktree is removed together with its branch and unlocked", async () => {
    const t = setup()
    await t.manager.prepare("p", { agent: "worker", prompt: "x" })
    const s = t.manager.get("ses_child1")!
    const done = await t.manager.finish("ses_child1")
    expect(done?.state).toBe("removed")
    expect(existsSync(s.path)).toBe(false)
    expect(git(t.f.repo, "branch", "--list", s.branch)).toBe("")
    expect(statusLine(done!)).toContain("removed")
  })

  test("untracked file keeps the worktree, unlocked", async () => {
    const t = setup()
    await t.manager.prepare("p", { agent: "worker", prompt: "x" })
    const s = t.manager.get("ses_child1")!
    writeFileSync(join(s.path, "new.txt"), "x")
    const done = await t.manager.finish("ses_child1")
    expect(done).toMatchObject({ state: "kept", files: 1, commits: 0 })
    expect(existsSync(s.path)).toBe(true)
    expect(lockOf(t.f.repo, s.path)?.locked).toBeUndefined()
    expect(t.manager.contextText("p")).toContain("1 changed file(s)")
  })

  test("a commit alone keeps the worktree", async () => {
    const t = setup()
    await t.manager.prepare("p", { agent: "worker", prompt: "x" })
    const s = t.manager.get("ses_child1")!
    writeFileSync(join(s.path, "x.txt"), "x")
    git(s.path, "add", "-A")
    git(s.path, "commit", "-qm", "work")
    expect(await t.manager.finish("ses_child1")).toMatchObject({ state: "kept", files: 0, commits: 1 })
    expect(git(t.f.repo, "branch", "--list", s.branch)).toContain(s.branch)
  })

  test("is idempotent and never touches foreign locks", async () => {
    const t = setup()
    await t.manager.prepare("p", { agent: "worker", prompt: "x" })
    const s = t.manager.get("ses_child1")!
    writeFileSync(join(s.path, "new.txt"), "x")
    git(t.f.repo, "worktree", "unlock", s.path)
    git(t.f.repo, "worktree", "lock", "--reason", "someone-else", s.path)
    await t.manager.finish("ses_child1")
    await t.manager.finish("ses_child1")
    expect(lockOf(t.f.repo, s.path)?.locked).toBe("someone-else")
  })
})

describe("continuation", () => {
  test("recreates a removed worktree from the same base and moves the session back", async () => {
    const t = setup()
    await t.manager.prepare("p", { agent: "worker", prompt: "x" })
    const before = t.manager.get("ses_child1")!
    await t.manager.finish("ses_child1")
    expect(existsSync(before.path)).toBe(false)
    const out = await t.manager.prepare("p", { agent: "worker", sessionID: "ses_child1", prompt: "again" })
    const after = t.manager.get("ses_child1")!
    expect(existsSync(after.path)).toBe(true)
    expect(after.path).toBe(before.path)
    expect(git(after.path, "rev-parse", "HEAD")).toBe(before.baseSha)
    expect(after.state).toBe("running")
    expect(lockOf(t.f.repo, after.path)?.locked).toBe(`${LOCK_PREFIX}ses_child1`)
    expect(t.moves.at(-1)).toEqual({ sessionID: "ses_child1", directory: after.path })
    expect(out!.prompt).toEndWith("again")
    expect(out!.prompt).not.toContain("You are a subagent spawned")
  })

  test("a late finish event from the previous turn does not tear down the recreated worktree", async () => {
    const t = setup()
    await t.manager.prepare("p", { agent: "worker", prompt: "x" })
    await t.manager.finish("ses_child1", { force: true })
    await t.manager.prepare("p", { agent: "worker", sessionID: "ses_child1", prompt: "again" })
    const s = t.manager.get("ses_child1")!
    await t.manager.finish("ses_child1")
    expect(s.state).toBe("running")
    expect(existsSync(s.path)).toBe(true)
    await t.manager.onStarted("ses_child1")
    await t.manager.finish("ses_child1")
    expect(s.state).toBe("removed")
  })

  test("kept worktree is relocked without being recreated", async () => {
    const t = setup()
    await t.manager.prepare("p", { agent: "worker", prompt: "x" })
    const s = t.manager.get("ses_child1")!
    writeFileSync(join(s.path, "w.txt"), "w")
    await t.manager.finish("ses_child1")
    const movesBefore = t.moves.length
    await t.manager.prepare("p", { agent: "worker", sessionID: "ses_child1", prompt: "more" })
    expect(t.moves).toHaveLength(movesBefore)
    expect(lockOf(t.f.repo, s.path)?.locked).toBe(`${LOCK_PREFIX}ses_child1`)
  })
})

describe("sweep and persistence", () => {
  test("state survives a restart; stale running records are finished, foreign locks untouched", async () => {
    const t = setup()
    await t.manager.prepare("p", { agent: "worker", prompt: "x" })
    await t.manager.prepare("p", { agent: "worker", prompt: "y" })
    const dirty = t.manager.get("ses_child1")!
    writeFileSync(join(dirty.path, "w.txt"), "w")
    const clean = t.manager.get("ses_child2")!
    const restarted = new WorktreeManager({
      ...t.host,
      now: () => Date.now() + 10 * 60 * 1000,
    })
    await restarted.sweep()
    expect(restarted.get("ses_child1")?.state).toBe("kept")
    expect(restarted.get("ses_child2")?.state).toBe("removed")
    expect(existsSync(dirty.path)).toBe(true)
    expect(existsSync(clean.path)).toBe(false)
    expect(lockOf(t.f.repo, dirty.path)?.locked).toBeUndefined()
  })

  test("recently active running sessions are left alone", async () => {
    const t = setup()
    await t.manager.prepare("p", { agent: "worker", prompt: "x" })
    await new WorktreeManager(t.host).sweep()
    expect(t.store.get("wt/ses_child1").state).toBe("running")
  })
})

describe("isolation lookups", () => {
  test("by session and by cwd", async () => {
    const t = setup()
    await t.manager.prepare("p", { agent: "worker", prompt: "x" })
    const s = t.manager.get("ses_child1")!
    expect(t.manager.isolationFor("ses_child1")).toMatchObject({ worktree: s.path, mainRoot: s.repoRoot })
    expect(t.manager.isolationFor("ses_other")).toBeUndefined()
    expect(t.manager.isolationForCwd(join(s.path, "sub"))?.worktree).toBe(s.path)
    expect(t.manager.isolationForCwd(s.repoRoot)).toBeUndefined()
    expect(t.manager.checkEvaluation("ses_child1", { action: "edit", resources: [join(s.repoRoot, "a.txt")] })).toContain(s.path)
    expect(t.manager.checkEvaluation("ses_other", { action: "edit", resources: [join(s.repoRoot, "a.txt")] })).toBeUndefined()
    mkdirSync(join(s.path, "sub"), { recursive: true })
  })
})
