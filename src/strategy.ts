import { existsSync, realpathSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { basename } from "node:path"
import { Worktree } from "@opencode/plugin"
import { resolveBase } from "./base.js"
import { gitOut, type GitRunner } from "./git.js"
import { copyIncluded } from "./include.js"
import { mainCheckoutFromCommonDir, parseWorktreeList } from "./manager.js"
import { branchFor, norm, randomSuffix, sanitizeName, worktreeDir, worktreesRoot } from "./paths.js"

export const STRATEGY_ID = "opencode-worktrees"

async function mainRoot(git: GitRunner, directory: string): Promise<string> {
  const common = await gitOut(git, directory, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
  const root = mainCheckoutFromCommonDir(common)
  if (!root) throw new Error(`${directory} is not inside a non-bare git checkout`)
  return existsSync(root) ? realpathSync.native(root) : root
}

export function createStrategy(git: GitRunner, random: () => number = Math.random) {
  const failedFetches = new Map<string, number>()
  return {
    id: STRATEGY_ID,

    async create(input: { sourceDirectory: string; directory: string; branch?: string }, _context: { signal: AbortSignal }) {
      const root = await mainRoot(git, input.sourceDirectory)
      const wanted = sanitizeName(basename(input.directory))
      let name = wanted
      for (let i = 0; i < 20 && (existsSync(worktreeDir(root, name)) || (await git(root, ["show-ref", "--verify", "-q", `refs/heads/${branchFor(name)}`])).code === 0); i++) {
        name = `${wanted}-${randomSuffix(random, 4)}`
      }
      const startSha = input.branch
        ? await gitOut(git, root, ["rev-parse", "--verify", `${input.branch}^{commit}`])
        : (await resolveBase(root, { git, failedAttempts: failedFetches })).sha
      const directory = worktreeDir(root, name)
      await mkdir(worktreesRoot(root), { recursive: true })
      await gitOut(git, root, ["worktree", "add", "-b", branchFor(name), directory, startSha])
      await copyIncluded(git, root, directory).catch(() => undefined)
      return { directory }
    },

    async remove(input: { directory: string; force: boolean }, _context: { signal: AbortSignal }) {
      const root = await mainRoot(git, input.directory)
      const entry = parseWorktreeList((await git(root, ["worktree", "list", "--porcelain"])).stdout).find((e) => norm(e.path) === norm(input.directory))
      if (!entry) throw new Error(`${input.directory} is not a registered worktree`)
      if (!input.force) {
        const status = await git(input.directory, ["status", "--porcelain", "--untracked-files=all"])
        if (status.stdout.trim()) throw new Worktree.OperationError({ message: "Uncommitted changes", forceRequired: true })
      }
      if (entry.locked) await git(root, ["worktree", "unlock", input.directory])
      await gitOut(git, root, ["worktree", "remove", "--force", input.directory])
      const branch = entry.branch?.replace(/^refs\/heads\//, "")
      if (branch?.startsWith("worktree-")) await git(root, ["branch", "-D", branch])
    },

    async list(sourceDirectory: string, _context: { signal: AbortSignal }) {
      const root = await mainRoot(git, sourceDirectory)
      const owned = norm(worktreesRoot(root)) + "/"
      const entries = parseWorktreeList((await git(root, ["worktree", "list", "--porcelain"])).stdout)
      return entries
        .filter((entry) => norm(entry.path) === norm(root) || norm(entry.path).startsWith(owned))
        .map((entry) => ({ directory: entry.path, type: norm(entry.path) === norm(root) ? ("root" as const) : ("worktree" as const) }))
    },
  }
}
