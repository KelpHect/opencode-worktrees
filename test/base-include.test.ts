import { mkdirSync, rmSync, utimesSync, writeFileSync, existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { FETCH_TTL_MS, resolveBase } from "../src/base.js"
import { runGit, type GitRunner } from "../src/git.js"
import { copyIncluded, listIncludedFiles } from "../src/include.js"
import { git, makeFixture, tempDir } from "./helpers.js"

const touchFetchHead = (repo: string, ageMs: number) => {
  const file = join(repo, ".git", "FETCH_HEAD")
  writeFileSync(file, "")
  const when = new Date(Date.now() - ageMs)
  utimesSync(file, when, when)
}

describe("resolveBase", () => {
  test("recent fetch: uses origin/HEAD (not local HEAD) without fetching", async () => {
    const f = makeFixture()
    touchFetchHead(f.repo, 1000)
    let fetched = false
    const spy: GitRunner = (cwd, args, o) => ((fetched ||= args[0] === "fetch"), runGit(cwd, args, o))
    const base = await resolveBase(f.repo, { git: spy })
    expect(base).toMatchObject({ ref: "origin/main", sha: f.c2, source: "origin-head", fetch: "fresh" })
    expect(base.sha).not.toBe(f.c3)
    expect(fetched).toBe(false)
  })

  test("stale fetch: fetches the default branch (non-interactive, capped) and picks up new origin commits", async () => {
    const f = makeFixture()
    const other = join(f.root, "other")
    git(f.root, "clone", "-q", f.origin, other)
    writeFileSync(join(other, "n.txt"), "n")
    git(other, "add", "-A")
    git(other, "commit", "-qm", "c2b")
    git(other, "push", "-q", "origin", "main")
    const newTip = git(other, "rev-parse", "HEAD")
    touchFetchHead(f.repo, FETCH_TTL_MS + 60_000)
    const calls: Array<{ args: string[]; timeoutMs?: number; env?: Record<string, string> }> = []
    const spy: GitRunner = (cwd, args, o) => (calls.push({ args, timeoutMs: o?.timeoutMs, env: o?.env }), runGit(cwd, args, o))
    const base = await resolveBase(f.repo, { git: spy })
    const fetch = calls.find((c) => c.args[0] === "fetch")!
    expect(fetch.args).toContain("main")
    expect(fetch.timeoutMs).toBe(5000)
    expect(fetch.env?.GIT_TERMINAL_PROMPT).toBe("0")
    expect(fetch.env?.GIT_SSH_COMMAND).toContain("BatchMode=yes")
    expect(base).toMatchObject({ sha: newTip, fetch: "fetched" })
  })

  test("stale fetch that fails keeps the cached origin ref", async () => {
    const f = makeFixture()
    rmSync(f.origin, { recursive: true, force: true })
    const failures = new Map<string, number>()
    const base = await resolveBase(f.repo, { git: runGit, failedAttempts: failures })
    expect(base).toMatchObject({ ref: "origin/main", sha: f.c2, fetch: "fetch-failed" })
    expect(failures.size).toBe(1)
  })

  test("stale fetch that times out falls back to the cached ref, and is not retried right away", async () => {
    const f = makeFixture()
    let fetches = 0
    const hanging: GitRunner = async (cwd, args, o) => {
      if (args[0] === "fetch") {
        fetches++
        return { code: null, stdout: "", stderr: "", timedOut: true }
      }
      return runGit(cwd, args, o)
    }
    const failures = new Map<string, number>()
    const a = await resolveBase(f.repo, { git: hanging, failedAttempts: failures })
    const b = await resolveBase(f.repo, { git: hanging, failedAttempts: failures })
    expect(a.sha).toBe(f.c2)
    expect(b.sha).toBe(f.c2)
    expect(fetches).toBe(1)
  })

  test("no remote falls back to local HEAD", async () => {
    const f = makeFixture({ origin: false })
    const base = await resolveBase(f.repo, { git: runGit })
    expect(base).toMatchObject({ ref: "HEAD", sha: f.c3, source: "head", fetch: "no-origin-head" })
  })

  test("remote without origin/HEAD falls back to local HEAD", async () => {
    const f = makeFixture()
    git(f.repo, "remote", "set-head", "origin", "-d")
    const base = await resolveBase(f.repo, { git: runGit })
    expect(base).toMatchObject({ ref: "HEAD", sha: f.c3, source: "head" })
  })
})

describe(".worktreeinclude", () => {
  const setup = () => {
    const f = makeFixture({ origin: false })
    writeFileSync(join(f.repo, ".env.local"), "SECRET=1\n")
    mkdirSync(join(f.repo, "secrets", "deep"), { recursive: true })
    writeFileSync(join(f.repo, "secrets", "deep", "k.txt"), "k")
    writeFileSync(join(f.repo, "secrets", "other.txt"), "o")
    writeFileSync(join(f.repo, "untracked-not-ignored.txt"), "u")
    return f
  }

  test("copies only gitignored files matching patterns", async () => {
    const f = setup()
    writeFileSync(join(f.repo, ".worktreeinclude"), "# comment\n.env.local\nsecrets/deep/\nuntracked-not-ignored.txt\n*.nomatch\n")
    expect((await listIncludedFiles(runGit, f.repo)).sort()).toEqual([".env.local", "secrets/deep/k.txt"])
    const target = join(f.root, "wt")
    mkdirSync(target)
    const copied = await copyIncluded(runGit, f.repo, target)
    expect(copied.sort()).toEqual([".env.local", "secrets/deep/k.txt"])
    expect(readFileSync(join(target, ".env.local"), "utf8")).toBe("SECRET=1\n")
    expect(existsSync(join(target, "secrets", "other.txt"))).toBe(false)
    expect(existsSync(join(target, "untracked-not-ignored.txt"))).toBe(false)
  })

  test("negation and globs follow gitignore semantics", async () => {
    const f = setup()
    writeFileSync(join(f.repo, ".worktreeinclude"), "secrets/**\n!secrets/other.txt\n")
    expect((await listIncludedFiles(runGit, f.repo)).sort()).toEqual(["secrets/deep/k.txt"])
  })

  test("no file or only comments means nothing is copied", async () => {
    const f = setup()
    expect(await listIncludedFiles(runGit, f.repo)).toEqual([])
    writeFileSync(join(f.repo, ".worktreeinclude"), "# nothing\n\n")
    expect(await listIncludedFiles(runGit, f.repo)).toEqual([])
  })
})

test("tempDir helper is unique", () => expect(tempDir()).not.toBe(tempDir()))
