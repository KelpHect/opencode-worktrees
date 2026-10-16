import path from "node:path"
import { describe, expect, test } from "bun:test"
import { checkEvaluation, checkShellCommand, type Isolation } from "../src/enforce.js"
import { branchFor, isUnder, norm, parseModelRef, randomSuffix, worktreeDir, worktreeName, worktreesRoot } from "../src/paths.js"

const iso: Isolation = {
  mainRoot: "C:\\work\\repo",
  worktree: "C:\\work\\repo.worktrees\\worker-ab12cd",
  branch: "worktree-worker-ab12cd",
}

describe("paths", () => {
  test("norm handles slashes, case, trailing slash, dot segments", () => {
    expect(norm("C:\\work\\Repo\\")).toBe("c:/work/repo")
    expect(norm("c:/work/repo/./a/../b")).toBe("c:/work/repo/b")
  })
  test("isUnder is boundary aware (shared prefixes are not inside)", () => {
    expect(isUnder("C:\\work\\repo\\src\\a.ts", "c:/work/REPO")).toBe(true)
    expect(isUnder("C:\\work\\repo", "C:\\work\\repo")).toBe(true)
    expect(isUnder("C:\\work\\repo2\\a.ts", "C:\\work\\repo")).toBe(false)
    expect(isUnder("C:\\work\\repo.worktrees\\x", "C:\\work\\repo")).toBe(false)
  })
  test("worktree location is next to the repo (Windows)", () => {
    expect(worktreesRoot("C:\\work\\repo", path.win32)).toBe("C:\\work\\repo.worktrees")
    expect(worktreeDir("C:\\work\\repo\\", "worker-ab12cd", path.win32)).toBe("C:\\work\\repo.worktrees\\worker-ab12cd")
  })
  test("names are <agent>-<6 [a-z0-9]> and branches prefixed", () => {
    expect(worktreeName("worker", () => 0)).toBe("worker-aaaaaa")
    expect(worktreeName("My Agent!")).toMatch(/^my-agent-[a-z0-9]{6}$/)
    expect(randomSuffix(() => 0.999999)).toBe("999999")
    expect(branchFor("worker-ab12cd")).toBe("worktree-worker-ab12cd")
  })
  test("parseModelRef", () => {
    expect(parseModelRef("opencode-go/step-5-preview")).toEqual({ providerID: "opencode-go", id: "step-5-preview" })
    expect(parseModelRef("openai/gpt-5#high")).toEqual({ providerID: "openai", id: "gpt-5", variant: "high" })
    expect(parseModelRef("nonsense")).toBeUndefined()
    expect(parseModelRef("/x")).toBeUndefined()
  })
})

describe("evaluation checks", () => {
  test("edit/external_directory in main are denied, inside worktree allowed", () => {
    expect(checkEvaluation({ action: "edit", resources: ["C:/work/repo/src/a.ts"] }, iso)).toContain(iso.worktree)
    expect(checkEvaluation({ action: "external_directory", resources: ["c:/work/repo/*"] }, iso)).toContain("main checkout")
    expect(checkEvaluation({ action: "edit", resources: ["src/a.ts"] }, iso)).toBeUndefined()
    expect(checkEvaluation({ action: "edit", resources: [iso.worktree + "\\src\\a.ts"] }, iso)).toBeUndefined()
    expect(checkEvaluation({ action: "read", resources: ["C:/work/repo/src/a.ts"] }, iso)).toBeUndefined()
  })
  test("relative path escaping into main is denied", () => {
    expect(checkEvaluation({ action: "edit", resources: ["..\\..\\repo\\a.ts"] }, iso)).toBeDefined()
    expect(checkEvaluation({ action: "edit", resources: ["..\\sibling\\a.ts"] }, iso)).toBeUndefined()
  })
  test("false positives: shared prefix, other repos", () => {
    expect(checkEvaluation({ action: "edit", resources: ["C:/work/repo2/a.ts"] }, iso)).toBeUndefined()
    expect(checkEvaluation({ action: "external_directory", resources: ["C:/work/repo-tools/*"] }, iso)).toBeUndefined()
    expect(checkEvaluation({ action: "edit", resources: ["C:/work/repo.worktrees/other/a.ts"] }, iso)).toBeUndefined()
  })
})

describe("shell redirect checks", () => {
  const blocked = [
    'git -C C:\\work\\repo status',
    'git -C "C:/work/repo" log',
    "git -C 'c:/work/repo/src' diff",
    "git --git-dir=C:/work/repo/.git status",
    "git --work-tree C:/work/repo status",
    "GIT_DIR=C:/work/repo/.git git status",
    "GIT_WORK_TREE=C:\\work\\repo git add .",
    '$env:GIT_DIR = "C:\\work\\repo\\.git"; git status',
    "cd C:/work/repo && git status",
    'cd /d "C:\\work\\repo" & git commit -am x',
    "git -C ..\\..\\repo status",
    "git add . && git -C C:/work/repo reset --hard",
  ]
  for (const command of blocked) test(`blocks: ${command}`, () => expect(checkShellCommand(command, iso)).toContain(iso.worktree))

  const allowed = [
    "git status",
    `git -C ${iso.worktree} status`,
    "git -C C:/work/repo2 status",
    "git -C C:/work/repo.worktrees/other status",
    "cd C:/work/repo2 && git status",
    "cd C:/work/repo && ls",
    "echo C:/work/repo",
    "git -C src status",
    "git diff --stat origin/main..HEAD",
  ]
  for (const command of allowed) test(`allows: ${command}`, () => expect(checkShellCommand(command, iso)).toBeUndefined())
})
