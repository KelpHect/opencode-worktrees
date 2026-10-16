import { describe, expect, test } from "bun:test"
import { isAbsolute } from "node:path"
import { loadBundledSkill, parseSkill } from "../src/skills.js"

describe("bundled skill", () => {
  test("loads from the package with frontmatter and absolute path", () => {
    const skill = loadBundledSkill("worktree-isolation")
    expect(skill.id).toBe("worktree-isolation")
    expect(skill.name.length).toBeGreaterThan(0)
    expect(skill.description?.length ?? 0).toBeGreaterThan(20)
    expect(isAbsolute(skill.path)).toBe(true)
    expect(skill.content.startsWith("---")).toBe(false)
    expect(skill.content.length).toBeGreaterThan(200)
  })
  test("parseSkill handles quotes, CRLF and missing frontmatter", () => {
    expect(parseSkill("x", "/p", '---\r\nname: "A b"\r\ndescription: d\r\n---\r\nbody\r\n')).toMatchObject({ name: "A b", description: "d", content: "body" })
    expect(parseSkill("x", "/p", "just text")).toMatchObject({ name: "x", content: "just text" })
  })
})
