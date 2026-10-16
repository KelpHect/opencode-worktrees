import { copyFile, mkdir, readFile, stat } from "node:fs/promises"
import { dirname, join } from "node:path"
import { gitOut, type GitRunner } from "./git.js"

export const INCLUDE_FILE = ".worktreeinclude"
const MAX_FILES = 20000

const lines = (text: string) => text.split(/\r?\n/).filter(Boolean)

/**
 * Gitignored, untracked files matching the gitignore-style patterns in `.worktreeinclude`.
 * Uses git's own pattern engine, intersected with what .gitignore really ignores.
 */
export async function listIncludedFiles(git: GitRunner, mainRoot: string): Promise<string[]> {
  const exists = await stat(join(mainRoot, INCLUDE_FILE)).then(
    (s) => s.isFile(),
    () => false,
  )
  if (!exists) return []
  const patterns = (await readFile(join(mainRoot, INCLUDE_FILE), "utf8")).split(/\r?\n/).some((l) => l.trim() && !l.trim().startsWith("#"))
  if (!patterns) return []
  const matched = lines(await gitOut(git, mainRoot, ["ls-files", "-z", "--others", "--ignored", `--exclude-from=${INCLUDE_FILE}`]).then((o) => o.replace(/\0/g, "\n")))
  if (matched.length === 0) return []
  const ignored = new Set(
    lines(await gitOut(git, mainRoot, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard"]).then((o) => o.replace(/\0/g, "\n"))),
  )
  return matched.filter((file) => ignored.has(file) && !file.startsWith(".git/")).slice(0, MAX_FILES)
}

export async function copyIncluded(git: GitRunner, mainRoot: string, worktree: string): Promise<string[]> {
  const files = await listIncludedFiles(git, mainRoot)
  const copied: string[] = []
  for (const file of files) {
    const target = join(worktree, file)
    await mkdir(dirname(target), { recursive: true })
    await copyFile(join(mainRoot, file), target).then(
      () => copied.push(file),
      () => undefined,
    )
  }
  return copied
}
