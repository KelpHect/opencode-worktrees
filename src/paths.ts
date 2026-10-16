import path from "node:path"

/** Comparison key: forward slashes, no trailing slash, lower case, dot segments resolved. */
export function norm(p: string): string {
  let s = p.replace(/\\/g, "/")
  const drive = /^[A-Za-z]:/.test(s) ? s.slice(0, 2) : ""
  const rest = path.posix.normalize(drive ? s.slice(2) || "/" : s)
  s = (drive + rest).replace(/\/+$/, "")
  return s.toLowerCase()
}

export function isUnder(candidate: string, root: string): boolean {
  const c = norm(candidate)
  const r = norm(root)
  return c === r || c.startsWith(r + "/")
}

/** Resolve `p` against `base` when relative, then compare. */
export function resolveAgainst(p: string, base: string): string {
  const cleaned = p.replace(/^["']|["']$/g, "")
  if (/^[A-Za-z]:[\\/]/.test(cleaned) || cleaned.startsWith("/") || cleaned.startsWith("\\")) return cleaned
  return `${base.replace(/[\\/]+$/, "")}/${cleaned}`
}

export function worktreesRoot(mainRoot: string, mod: typeof path = path): string {
  const normalized = mainRoot.replace(/[\\/]+$/, "")
  return mod.join(mod.dirname(normalized), `${mod.basename(normalized)}.worktrees`)
}

export function worktreeDir(mainRoot: string, name: string, mod: typeof path = path): string {
  return mod.join(worktreesRoot(mainRoot, mod), name)
}

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"

export function randomSuffix(random: () => number = Math.random, length = 6): string {
  let out = ""
  for (let i = 0; i < length; i++) out += ALPHABET[Math.floor(random() * ALPHABET.length)]
  return out
}

export function sanitizeName(agent: string): string {
  return agent.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "agent"
}

export function worktreeName(agent: string, random: () => number = Math.random): string {
  return `${sanitizeName(agent)}-${randomSuffix(random)}`
}

export const branchFor = (name: string) => `worktree-${name}`

export function parseModelRef(value: string): { providerID: string; id: string; variant?: string } | undefined {
  const [ref, variant] = value.trim().split("#", 2)
  const slash = ref.indexOf("/")
  if (slash <= 0 || slash === ref.length - 1) return undefined
  return { providerID: ref.slice(0, slash), id: ref.slice(slash + 1), ...(variant ? { variant } : {}) }
}
