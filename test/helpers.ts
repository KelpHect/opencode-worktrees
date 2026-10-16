import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "core.autocrlf=false", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim()
}

export function tempDir(prefix = "wt-test-"): string {
  return realpathSync.native(mkdtempSync(join(tmpdir(), prefix)))
}

export interface Fixture {
  root: string
  repo: string
  origin: string
  c1: string
  c2: string
  c3: string
}

/** repo with origin (bare); origin/main = c2, local HEAD = c3 (one commit ahead). */
export function makeFixture(options: { origin?: boolean } = {}): Fixture {
  const root = tempDir()
  const repo = join(root, "proj")
  const origin = join(root, "origin.git")
  mkdirSync(repo)
  git(repo, "init", "-q", "-b", "main")
  writeFileSync(join(repo, "a.txt"), "a\n")
  writeFileSync(join(repo, ".gitignore"), ".env.local\nsecrets/\n")
  git(repo, "add", "-A")
  git(repo, "commit", "-qm", "c1")
  const c1 = git(repo, "rev-parse", "HEAD")
  writeFileSync(join(repo, "a.txt"), "a\nb\n")
  git(repo, "commit", "-qam", "c2")
  const c2 = git(repo, "rev-parse", "HEAD")
  if (options.origin !== false) {
    git(root, "init", "-q", "--bare", "-b", "main", origin)
    git(repo, "remote", "add", "origin", origin)
    git(repo, "push", "-q", "origin", "main")
    git(repo, "remote", "set-head", "origin", "main")
  }
  writeFileSync(join(repo, "c3.txt"), "c3\n")
  git(repo, "add", "-A")
  git(repo, "commit", "-qm", "c3")
  const c3 = git(repo, "rev-parse", "HEAD")
  return { root, repo, origin, c1, c2, c3 }
}
