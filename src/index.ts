import { Plugin } from "@opencode/plugin"
import { loadBundledSkill } from "./skills.js"
import { checkShellCommand } from "./enforce.js"
import { runGit } from "./git.js"
import { WorktreeManager, statusLine, type ManagerHost, type SubagentInput } from "./manager.js"
import { createStrategy } from "./strategy.js"

const PREFIX = "[opencode-worktrees]"
const DEFAULT_ISOLATED = ["worker"]

interface Shared {
  manager: WorktreeManager
  holder: { host: ManagerHost }
  handled: Set<string>
  refs: number
}

// OpenCode instantiates a plugin once per location inside one process, and every instance receives the
// global event stream. State must be shared so that instances neither diverge nor handle an event twice.
let shared: Shared | undefined

function acquire(host: ManagerHost): Shared {
  if (shared) {
    shared.holder.host = host
    shared.refs++
    return shared
  }
  const holder = { host }
  const proxy: ManagerHost = {
    get git() {
      return holder.host.git
    },
    storage: { get: (k) => holder.host.storage.get(k), set: (k, v) => holder.host.storage.set(k, v), remove: (k) => holder.host.storage.remove(k) },
    session: {
      get: (i) => holder.host.session.get(i),
      create: (i) => holder.host.session.create(i),
      move: (i) => holder.host.session.move(i),
    },
    agentModel: (a) => holder.host.agentModel(a),
    get isolatedAgents() {
      return holder.host.isolatedAgents
    },
    log: (l, m, e) => holder.host.log?.(l, m, e),
  }
  return (shared = { manager: new WorktreeManager(proxy), holder, handled: new Set(), refs: 1 })
}

export default Plugin.define({
  id: "opencode-worktrees",
  async setup(ctx) {
    const configured = ctx.options.isolatedAgents
    const isolatedAgents =
      Array.isArray(configured) && configured.every((a) => typeof a === "string") ? (configured as string[]) : DEFAULT_ISOLATED

    const host: ManagerHost = {
      git: runGit,
      storage: ctx.storage as ManagerHost["storage"],
      session: {
        get: (input) => ctx.session.get({ sessionID: input.sessionID }) as any,
        create: (input) => ctx.session.create(input as any) as any,
        move: (input) => ctx.session.move(input),
      },
      agentModel: async (agent) => {
        const info: any = await ctx.agent.get({ agentID: agent }).catch(() => undefined)
        const model = info?.data?.model ?? info?.model
        return model?.id && model?.providerID ? model : undefined
      },
      isolatedAgents,
      log: (level, message, extra) => {
        const line = extra === undefined ? `${PREFIX} ${message}` : `${PREFIX} ${message}: ${extra instanceof Error ? extra.message : JSON.stringify(extra)}`
        if (level === "error") console.error(line)
        else if (level === "warn") console.warn(line)
        else console.log(line)
      },
    }
    const instance = acquire(host)
    const manager = instance.manager
    await manager.load()

    const registrations = [
      await ctx.skill.transform((editor) => editor.add(loadBundledSkill("worktree-isolation") as any)),

      await ctx.tool.hook("execute.before", async (event) => {
        if (event.tool !== "subagent") return
        const prepared = await manager.prepare(event.sessionID, event.input as SubagentInput)
        if (prepared) event.input = prepared
      }),

      await ctx.tool.hook("execute.after", async (event) => {
        if (event.tool !== "subagent" || event.status !== "completed") return
        const childID = (event.input as SubagentInput | undefined)?.sessionID
        if (!childID || !manager.get(childID)) return
        const output: any = (event.result as any)?.output
        const done = output?.status !== "running"
        const state = done ? await manager.finish(childID, { force: true }) : manager.get(childID)
        if (!state) return
        const text = statusLine(state) + (state.state === "kept" ? `\nMerge: git merge ${state.branch} (from ${state.repoRoot}), then git worktree remove ${state.path} && git branch -d ${state.branch}` : "")
        const content = (event.result as any).content
        if (Array.isArray(content) && content.some((part: any) => part?.text === text)) return
        event.result = {
          ...event.result,
          content: Array.isArray(content) ? [...content, { type: "text", text }] : `${content ?? ""}\n\n${text}`,
        } as any
      }),

      await ctx.permission.hook("evaluate", (event) => {
        const message = manager.checkEvaluation(event.sessionID, { action: event.action, resources: event.resources })
        if (message) {
          event.effect = "deny"
          event.message = message
        }
      }),

      await ctx.shell.hook("create.before", (event) => {
        const iso = manager.isolationForCwd(event.cwd)
        if (!iso) return
        const message = checkShellCommand(event.command, iso)
        if (message) throw new Error(message)
      }),

      await ctx.session.hook("context", (event) => {
        const text = manager.contextText(event.sessionID)
        if (text && !event.system.some((part: any) => part.text === text)) event.system.push({ type: "text", text })
      }),
      await ctx.session.hook("compaction", (event) => {
        const text = manager.contextText(event.sessionID)
        if (text && !event.system.some((part: any) => part.text === text)) event.system.push({ type: "text", text })
      }),

      await ctx.worktree.transform((editor) => {
        editor.add(createStrategy(runGit) as any)
      }),
    ]

    const abort = new AbortController()
    const handle = async (event: any) => {
      const sessionID: string | undefined = event?.data?.sessionID
      if (!sessionID || !manager.get(sessionID)) return
      if (event.id) {
        if (instance.handled.has(event.id)) return
        instance.handled.add(event.id)
        if (instance.handled.size > 5000) instance.handled.delete(instance.handled.values().next().value as string)
      }
      try {
        if (event.type === "session.execution.started") await manager.onStarted(sessionID)
        else if (event.type === "session.execution.succeeded" || event.type === "session.execution.failed") await manager.finish(sessionID)
        else if (event.type === "session.execution.interrupted" && event.data.reason !== "superseded") await manager.finish(sessionID)
      } catch (error) {
        host.log?.("error", `event handler failed (${event.type})`, error)
      }
    }
    void (async () => {
      while (!abort.signal.aborted) {
        try {
          for await (const event of ctx.event.subscribe({ signal: abort.signal })) void handle(event)
        } catch (error) {
          if (abort.signal.aborted) return
          host.log?.("error", "event stream failed; retrying", error)
        }
        if (!abort.signal.aborted) await new Promise((resolve) => setTimeout(resolve, 1000))
      }
    })()

    void manager.sweep().catch((error) => host.log?.("warn", "startup sweep failed", error))

    return async () => {
      abort.abort()
      if (--instance.refs <= 0 && shared === instance) shared = undefined
      await Promise.allSettled(registrations.map((registration) => registration.dispose()))
    }
  },
})
