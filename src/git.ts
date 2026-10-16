import { spawn } from "node:child_process"

export interface GitResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export interface GitOptions {
  timeoutMs?: number
  env?: Record<string, string>
}

export type GitRunner = (cwd: string, args: string[], options?: GitOptions) => Promise<GitResult>

export const NON_INTERACTIVE_ENV: Record<string, string> = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
}

export const runGit: GitRunner = (cwd, args, options = {}) =>
  new Promise((resolve) => {
    const child = spawn("git", ["-c", "core.quotepath=false", ...args], {
      cwd,
      windowsHide: true,
      env: { ...process.env, ...options.env },
    })
    let stdout = ""
    let stderr = ""
    let timedOut = false
    child.stdout.on("data", (chunk) => (stdout += chunk))
    child.stderr.on("data", (chunk) => (stderr += chunk))
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true
          child.kill()
        }, options.timeoutMs)
      : undefined
    child.on("error", (error) => {
      if (timer) clearTimeout(timer)
      resolve({ code: null, stdout, stderr: stderr || String(error), timedOut })
    })
    child.on("close", (code) => {
      if (timer) clearTimeout(timer)
      resolve({ code, stdout, stderr, timedOut })
    })
  })

export async function gitOut(git: GitRunner, cwd: string, args: string[], options?: GitOptions): Promise<string> {
  const result = await git(cwd, args, options)
  if (result.code !== 0) throw new Error(`git ${args.slice(0, 3).join(" ")} failed: ${(result.stderr || result.stdout).trim().slice(0, 400)}`)
  return result.stdout.trim()
}
