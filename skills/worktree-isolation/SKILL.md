---
name: Worktree isolation
description: How to run editing subagents in isolated git worktrees (opencode-worktrees plugin) - when to isolate, how to brief an isolated agent, and how to merge or discard its branch afterwards.
---

# Worktree isolation

The opencode-worktrees plugin gives selected subagents their own temporary git worktree. Isolated agents are listed in the plugin's `isolatedAgents` option (default: `worker`). Launch them with the normal `subagent` tool; the plugin does the rest:

- Creates `<repo-parent>/<repo>.worktrees/<agent>-<id>` on a new branch `worktree-<agent>-<id>`, starting from origin's default branch (or local `HEAD` when there is no remote).
- Copies the gitignored files listed in `.worktreeinclude` (gitignore syntax, at the repo root), e.g. `.env`.
- Tells the subagent its path, branch and base, and refuses edits, commands and git operations that target the main checkout.
- When the subagent finishes: removes the worktree and branch if nothing changed; otherwise keeps both and lists them in your context as `kept - N changed file(s), M commit(s)`.

## When to isolate

| Situation | Agent |
| --- | --- |
| Two or more subagents editing code at the same time | isolated agent, one per task |
| A risky or experimental change you may throw away | isolated agent |
| A single editing subagent, nothing else editing | non-isolated agent is fine |
| Read-only research, search, review | non-isolated read-only agent |
| Task needs your uncommitted local changes | non-isolated agent (worktrees start from the default branch, not your working tree); or commit first |
| Repo tracks very large binaries | non-isolated agent; every worktree is a full checkout of tracked files |
| Not a git repository | non-isolated agent; isolation fails with an error |

## Briefing an isolated agent

The plugin already prepends the path/branch note. Your prompt still needs to be self-contained:

```
Goal: <one sentence>.
Files you own: <paths>. Do not touch other files.
Context: <what you know: symbols, line numbers, constraints, decisions already made>.
Done when: <tests/build/command that must pass>.
Finish by committing on your branch with a message describing the change.
Report: branch name, `git diff --stat` vs base, what you verified and how, anything left undone.
```

Give parallel agents disjoint files. Two isolated agents editing the same file will each succeed, but you will get a merge conflict later.

## Integrating results

For each kept worktree listed in your context:

1. Review: `git -C <worktree> log --oneline <base>..HEAD` and `git -C <worktree> diff <base>..HEAD`.
2. Merge from the main checkout: `git merge --no-ff <branch>` (or cherry-pick specific commits).
3. Clean up: `git worktree remove <worktree>` then `git branch -d <branch>`.

To discard: `git worktree remove --force <worktree>` then `git branch -D <branch>`. Never remove a kept worktree without reviewing it first.

To send follow-up work to the same isolated agent, call `subagent` again with its `sessionID`; the plugin recreates the worktree on the same branch if it was removed.

## Correct vs incorrect

- Correct: three parallel isolated agents, each owning one module, each committing on its branch; you merge them one by one and run the tests after each merge.
- Incorrect: telling an isolated agent to "edit /path/to/repo/src/x.c" (an absolute path in the main checkout). Give paths relative to the repo root; the agent resolves them inside its worktree.
- Incorrect: telling an isolated agent to `git push`, `git checkout main` or merge into the main checkout itself. Integration is your job.
- Incorrect: assuming the agent sees your uncommitted edits. It starts from the default branch.
