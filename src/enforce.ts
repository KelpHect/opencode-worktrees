import { isUnder, resolveAgainst } from "./paths.js"

export interface Isolation {
  mainRoot: string
  worktree: string
  branch: string
}

export function refusal(iso: Isolation, what: string): string {
  return (
    `Blocked: ${what}. This session is isolated in the git worktree ${iso.worktree} (branch ${iso.branch}); ` +
    `the main checkout at ${iso.mainRoot} is off limits. Work only inside ${iso.worktree}: use paths under it ` +
    `and run commands with that as the working directory.`
  )
}

export function touchesMain(pathLike: string, iso: Isolation): boolean {
  const resolved = resolveAgainst(pathLike, iso.worktree)
  return isUnder(resolved, iso.mainRoot) && !isUnder(resolved, iso.worktree)
}

const ARG = `("[^"]*"|'[^']*'|[^\\s;&|"']+)`
const unquote = (s: string) => s.replace(/^["']|["']$/g, "")

function* matches(pattern: RegExp, text: string): Generator<RegExpExecArray> {
  const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g")
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) yield m
}

export function checkShellCommand(command: string, iso: Isolation): string | undefined {
  for (const m of matches(new RegExp(`\\bgit(?:\\.exe)?\\b[^|;&\\n]*?\\s-C\\s+${ARG}`, "gi"), command)) {
    if (touchesMain(unquote(m[1]), iso)) return refusal(iso, "git -C targets the main checkout")
  }
  for (const m of matches(new RegExp(`--(?:git-dir|work-tree)(?:=|\\s+)${ARG}`, "gi"), command)) {
    if (touchesMain(unquote(m[1]), iso)) return refusal(iso, "--git-dir/--work-tree points at the main checkout")
  }
  for (const m of matches(new RegExp(`\\bGIT_(?:DIR|WORK_TREE|INDEX_FILE)\\s*=\\s*${ARG}`, "gi"), command)) {
    if (touchesMain(unquote(m[1]), iso)) return refusal(iso, "GIT_DIR/GIT_WORK_TREE points at the main checkout")
  }
  for (const m of matches(new RegExp(`(?:^|[\\s;&|(])(?:cd|chdir|pushd|set-location|sl)\\s+(?:/d\\s+)?(?:-(?:path|literalpath)\\s+)?${ARG}`, "gi"), command)) {
    if (!touchesMain(unquote(m[1]), iso)) continue
    const after = command.slice((m.index ?? 0) + m[0].length)
    if (/\bgit(?:\.exe)?\b/i.test(after)) return refusal(iso, "cd into the main checkout followed by git")
  }
  return undefined
}

export interface Evaluation {
  action: string
  resources: ReadonlyArray<string>
}

export function checkEvaluation(evaluation: Evaluation, iso: Isolation): string | undefined {
  switch (evaluation.action) {
    case "edit":
    case "external_directory":
      for (const resource of evaluation.resources) {
        const cleaned = resource.replace(/[\\/]\*+$/, "")
        if (touchesMain(cleaned, iso)) return refusal(iso, `${evaluation.action === "edit" ? "editing" : "accessing"} ${cleaned} in the main checkout`)
      }
      return undefined
    case "shell":
      for (const resource of evaluation.resources) {
        const verdict = checkShellCommand(resource, iso)
        if (verdict) return verdict
      }
      return undefined
    default:
      return undefined
  }
}
