# opencode-worktrees

Git worktree isolation for [OpenCode](https://opencode.ai) v2 subagents. Mark an agent as isolated and every time it is launched through the `subagent` tool it works in its own temporary git worktree on its own branch, branched from the repository's default branch. Parallel editing agents never touch the same files, and the orchestrator merges the branches afterwards.

The design is inspired by Claude Code's `isolation: worktree` subagent setting (the behaviour, not any copied code or text).

Tested with OpenCode 2.0.30 (`@opencode/plugin` 2.0.30). Requires `git`.

## Features

- Creates `<repo-parent>/<repo>.worktrees/<agent>-<id>` on a new branch `worktree-<agent>-<id>`, starting from `origin/HEAD` ("fresh"). If origin was not fetched in the last 24 hours the default branch is fetched first (5 second cap, non-interactive, cached ref used on failure). With no remote, or no resolvable `origin/HEAD`, it falls back to local `HEAD`.
- Moves the subagent's session into the worktree before its first prompt and tells it the worktree path, branch and base.
- Locks the worktree while the agent runs (`git worktree lock` with a reason that identifies this plugin and the session) and unlocks it afterwards. Only locks it set itself are ever released.
- Removes the worktree and branch automatically when the agent finishes with no changes (no modified or untracked files and no new commits); keeps both when there is work.
- Copies gitignored files listed in a `.worktreeinclude` file at the repository root (gitignore syntax) into each new worktree, for example `.env`.
- Enforcement while isolated: edits and external-directory access targeting the main checkout are denied, shell commands whose working directory is the main checkout are denied, and shell commands that redirect git into the main checkout (`git -C <main>`, `--git-dir`, `--work-tree`, `GIT_DIR=`, `GIT_WORK_TREE=`, `cd <main>` followed by git) are refused. Refusals tell the model where to work instead.
- Tells the parent session about its isolated children (path, branch, base, state, merge instructions) through the system prompt, and appends the same status to the result of a foreground `subagent` call.
- Continuing a finished isolated subagent (`subagent` with its `sessionID`) recreates the worktree on the same branch from the same base if it was removed.
- State is persisted through the plugin storage API. On startup a sweep releases its stale locks, removes clean worktrees of finished sessions and leaves worktrees with work alone.
- Registers a worktree strategy so OpenCode's own `worktree.create` uses the same `<repo>.worktrees/<name>` layout and fresh-base logic.
- A bundled skill (`worktree-isolation`) that teaches the model when to isolate, how to brief an isolated agent and how to merge or discard results.

## Install

```sh
opencode plugin add github:KelpHect/opencode-worktrees
```

Pin a release with `github:KelpHect/opencode-worktrees#v0.1.0`. Manual configuration:

```jsonc
{
  "plugins": [
    { "package": "github:KelpHect/opencode-worktrees#v0.1.0", "options": { "isolatedAgents": ["worker"] } }
  ]
}
```

Restart the service afterwards (`opencode service restart`).

## Define an isolated agent

By default the agent named `worker` is isolated. Define it in `opencode.json`:

```jsonc
{
  "agents": {
    "worker": {
      "description": "Like general (full tool access) but runs in its own temporary git worktree branched from the repo's default branch, so parallel editors never collide. Use for code changes that run in parallel with other editing subagents. Reports its worktree path and branch; the orchestrator merges the branch. Requires a git repo.",
      "mode": "subagent",
      "model": "<provider>/<model>",
      "permissions": [
        { "action": "question", "resource": "*", "effect": "deny" },
        { "action": "subagent", "resource": "*", "effect": "deny" }
      ]
    }
  }
}
```

## Configuration

| Option | Default | Description |
| --- | --- | --- |
| `isolatedAgents` | `["worker"]` | Names of agents that run in an isolated worktree. |

## Usage

Launch the agent with the normal `subagent` tool (`agent: "worker"`), in the foreground or with `background: true`. When it finishes, the parent sees one of:

- `finished clean, worktree and branch removed`
- `kept - N changed file(s), M commit(s) ahead of base`

To integrate a kept worktree, from the main checkout: `git merge <branch>`, then `git worktree remove <path>` and `git branch -d <branch>`.

## The bundled skill

Plugins provide mechanisms; they cannot tell the model when to use them. The `worktree-isolation` skill (`skills/worktree-isolation/SKILL.md`) is registered automatically. It covers when to use an isolated agent versus a normal one, how to write a self-contained brief, how to give parallel agents disjoint files, and how to review, merge or discard the resulting branches.

## How it works

- A `tool.hook("execute.before")` on `subagent` prepares the worktree, creates the child session, moves it into the worktree and rewrites the tool input to continue that session, so the core subagent machinery handles prompting, background runs, notifications and navigation as usual.
- Finish detection uses `session.execution.*` events; a finished continuation is only acted on after the new turn has actually started.
- Enforcement uses the `permission.evaluate` hook (denies `edit`, `external_directory` and `shell` resources) and a `shell.create.before` hook (refuses git-redirect commands from inside a worktree).

## Limitations and known issues

- A worktree is a full checkout of tracked files, so repositories with very large tracked binaries make worktree creation slow and large.
- Isolated agents start from the default branch, not from your uncommitted working tree.
- Enforcement is pattern-based: it catches the common ways of reaching the main checkout, not every conceivable shell trick. `cd <main>` followed by something other than git is not blocked.
- On Windows the server can keep a handle on a session's directory, so git may deregister a clean worktree but fail to delete its (empty) directory; the plugin retries and sweeps such leftovers on the next start.
- Plugins are instantiated once per project location; this plugin shares one manager and de-duplicates events so that is invisible in practice.
- Requires a non-bare git repository; otherwise isolation fails with a clear error and you should use a non-isolated agent.

## Development

```sh
bun install
bun test
bunx tsc --noEmit
```

## License

MIT, see `LICENSE`. Copyright (c) 2026 KelpHect.
