import { stat } from "node:fs/promises"
import { join } from "node:path"
import { NON_INTERACTIVE_ENV, gitOut, type GitRunner } from "./git.js"

export const FETCH_TTL_MS = 24 * 60 * 60 * 1000
export const FETCH_TIMEOUT_MS = 5000
const RETRY_AFTER_FAILURE_MS = 10 * 60 * 1000

export interface BaseRef {
  ref: string
  sha: string
  source: "origin-head" | "head"
  fetch: "fresh" | "fetched" | "fetch-failed" | "no-origin-head"
}

export interface BaseDeps {
  git: GitRunner
  now?: () => number
  lastFetchedAt?: (commonDir: string) => Promise<number | undefined>
  failedAttempts?: Map<string, number>
}

export async function fetchHeadMtime(commonDir: string): Promise<number | undefined> {
  return stat(join(commonDir, "FETCH_HEAD"))
    .then((s) => s.mtimeMs)
    .catch(() => undefined)
}

async function headBase(git: GitRunner, repo: string, fetch: BaseRef["fetch"]): Promise<BaseRef> {
  return { ref: "HEAD", sha: await gitOut(git, repo, ["rev-parse", "--verify", "HEAD^{commit}"]), source: "head", fetch }
}

export async function resolveBase(repo: string, deps: BaseDeps): Promise<BaseRef> {
  const { git } = deps
  const now = deps.now ?? Date.now
  const sym = await git(repo, ["symbolic-ref", "-q", "refs/remotes/origin/HEAD"])
  const prefix = "refs/remotes/origin/"
  const full = sym.stdout.trim()
  if (sym.code !== 0 || !full.startsWith(prefix)) return headBase(git, repo, "no-origin-head")
  const branch = full.slice(prefix.length)

  const commonDir = await gitOut(git, repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
  const last = await (deps.lastFetchedAt ?? fetchHeadMtime)(commonDir)
  const failedAt = deps.failedAttempts?.get(commonDir)
  let fetch: BaseRef["fetch"] = "fresh"
  const stale = last === undefined || now() - last > FETCH_TTL_MS
  if (stale && !(failedAt !== undefined && now() - failedAt < RETRY_AFTER_FAILURE_MS)) {
    const result = await git(repo, ["fetch", "--quiet", "origin", branch], { timeoutMs: FETCH_TIMEOUT_MS, env: NON_INTERACTIVE_ENV })
    if (result.code === 0) fetch = "fetched"
    else {
      fetch = "fetch-failed"
      deps.failedAttempts?.set(commonDir, now())
    }
  } else if (stale) fetch = "fetch-failed"

  const sha = await git(repo, ["rev-parse", "--verify", "-q", `${full}^{commit}`])
  if (sha.code !== 0 || !sha.stdout.trim()) return headBase(git, repo, fetch)
  return { ref: `origin/${branch}`, sha: sha.stdout.trim(), source: "origin-head", fetch }
}
