import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

export interface BundledSkill {
  id: string
  name: string
  description?: string
  path: string
  content: string
}

export function parseSkill(id: string, path: string, source: string): BundledSkill {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(source)
  const fields: Record<string, string> = {}
  for (const line of (match?.[1] ?? "").split(/\r?\n/)) {
    const field = /^([A-Za-z_-]+):\s*(.*)$/.exec(line)
    if (field) fields[field[1]] = field[2].trim().replace(/^(["'])(.*)\1$/, "$2")
  }
  return {
    id,
    name: fields.name || id,
    ...(fields.description ? { description: fields.description } : {}),
    path,
    content: (match ? match[2] : source).trim(),
  }
}

export function loadBundledSkill(id: string): BundledSkill {
  const path = fileURLToPath(new URL(`../skills/${id}/SKILL.md`, import.meta.url))
  return parseSkill(id, path, readFileSync(path, "utf8"))
}
