# pi-interactive-subagents

Async subagents for [pi](https://github.com/badlogic/pi-mono), running in tmux or WezTerm panes. Spawn a sub-agent, keep working in the main session, and get the result steered back when it finishes. Fully non-blocking.

**tmux and WezTerm subagents.** Supports native WezTerm multiplexing on Windows 10/11 using native `pwsh` (PowerShell 7+), alongside tmux on POSIX. See [Acknowledgements](#acknowledgements) for the upstream project.

## Installation & Setup

- **Remote install:**
  ```
  pi install git:github.com/pedritojr1209/pi-interactive-subagents-for-wezterm
  ```
- **Global install (POSIX or Windows):**
  ```
  # POSIX — symlinks into ~/.local/bin (or equivalent)
  npm install -g pi-interactive-subagents
  # Windows — run in an elevated or user-scoped pwsh
  npm install -g pi-interactive-subagents
  ```
- **Local development / Manual (Windows pwsh):**
  ```powershell
  Copy-Item -Recurse -Force ".\pi-extension\subagents" "$HOME\.pi\agent\extensions\subagents"
  ```
- **On-the-fly / Ephemeral run (from any platform):**
  ```
  pi -e ./pi-extension/subagents/index.ts
  ```
- **Windows prerequisite:** Run inside WezTerm with `pwsh` (PowerShell 7+) as your default shell. WezTerm sets `$env:WEZTERM_PANE` automatically for every pane it spawns, which the extension uses for multiplexer detection.

## How it works

`subagent()` returns immediately. The sub-agent runs in its own tmux pane — a right split off the parent pi pane, so pane creation never steals keyboard focus. A live widget above the input tracks every running sub-agent, and when one finishes, its result is steered into the main session as a notification that triggers a new turn.

```
╭─ Subagents ──────────────────────────── 2 running ─╮
│ 00:23  scout      active · bash 7m                 │
│ 00:45  scout-2    waiting 2m                       │
╰────────────────────────────────────────────────────╯
```

Spawn several in parallel — they run concurrently and steer results back independently as each finishes.

Panes are kept evenly sized: the extension re-applies an `even-horizontal` layout after every spawn and exit (debounced). The layout is a single constant, `SUBAGENT_TMUX_LAYOUT` in `pi-extension/subagents/tmux.ts` — change it to any named tmux layout (`main-vertical`, `tiled`, …).

If your shell startup is slow and launch commands get dropped before the prompt is ready, raise the delay:

```bash
export PI_SUBAGENT_SHELL_READY_DELAY_MS=2500   # default: 500
```

## Tools

| Tool | Description |
| --- | --- |
| `subagent` | Spawn a sub-agent in a dedicated tmux pane (async) |
| `subagent_message` | Message a sub-agent by name — steers it if running, resumes its session if finished |
| `subagents_list` | List available agent definitions |
| `ask_question` | *(sub-agent sessions only)* Ask the orchestrator a question and wait for the reply |

There is also a `/subagent <agent> <task>` command for spawning directly.

### Spawning

```typescript
subagent({ agent: "scout", task: "Analyze the auth module" });
subagent({ agent: "worker", name: "dark-mode", task: "Implement the dark mode toggle" });
```

| Parameter | Type | Default | Description |
| --------- | ---- | ------- | ----------- |
| `agent` | string | required | Which agent to spawn (must be known and permitted) |
| `task` | string | required | Task prompt |
| `name` | string | agent name | Display name for the pane and widget. Must be unique — duplicates are auto-suffixed (`scout`, `scout-2`, …) |
| `model` | string | agent's model | Override the model for this spawn |
| `cwd` | string | agent's `cwd` | Working directory (see [Role folders](#role-folders)) |

### Messaging

`subagent_message` is addressed **by name only**. Names are unique per session and persist after a sub-agent finishes, so the same name works either way:

```typescript
subagent_message({ name: "scout", message: "Also check the auth middleware" });
```

- **Running** — the message is typed into the live pane (newlines flattened) and picked up at the next turn boundary. The call returns immediately; the eventual completion still arrives as a steer message.
- **Finished** — the session is resumed with the message as the follow-up task, like a fresh spawn: fire-and-forget, always autonomous, result steered back later. The resumed run reclaims its original name.

Every spawn records name → session file in `artifacts/<sessionId>/subagent-registry.json`, so names stay addressable across pi restarts. A nested sub-agent that spawns children gets its own registry keyed by its own session id. Resume is refused with a clear error (listing known names) if the name isn't registered, the session file is gone, or the session predates sandboxed resume.

**Resume replays the original sandbox.** At spawn time the fully-resolved loadout — tool allowlist, backing extensions, model, thinking level, system prompt, spawn whitelist, cwd — is snapshotted to `<session>.loadout.json`. Resume rebuilds the exact same restricted process from that snapshot rather than relaunching unrestricted.

### ask_question

A sub-agent can ask its orchestrator a single freeform question when requirements are ambiguous or a decision materially affects the work. The session **stays open** (parked as `waiting`) instead of exiting; the parent is notified with the sub-agent's name, replies via `subagent_message({ name, message })`, and the reply arrives as the sub-agent's next turn. Parallel questions are supported — each waiting sub-agent has its own name.

If the reply arrives while the sub-agent is still mid-turn, it is absorbed into the current turn — either way the question is marked answered and the session exits normally when the work is done. If the parent never replies, the pane stays open until a human closes it. Only available inside sub-agent sessions.

## Bundled agents

| Agent | Model | Tools | Role |
| ----- | ----- | ----- | ---- |
| **scout** | `openrouter/z-ai/glm-5.3` | `read`, `grep`, `find`, `ls` | Fast read-only codebase recon |
| **researcher** | `openrouter/z-ai/glm-5.3` | `web_search`, `web_fetch`, `safe_bash` | Web research, synthesized into a sourced brief |
| **worker** | `openrouter/z-ai/glm-5.3` | `read`, `write`, `edit`, `bash`, `web_search`, `web_fetch` + spawning | General implementer; may spawn `scout` and `researcher` |

All three are autonomous (`auto-exit: true`) and carry their identity in the system prompt (`system-prompt: append`).

## Custom agents

Place a `.md` file in `.pi/agents/` (project) or `~/.pi/agent/agents/` (global). Discovery priority: **project > global > package-bundled** — a project-local file overrides a bundled agent with the same name.

```markdown
---
name: my-agent
description: Does something specific
model: openrouter/z-ai/glm-5.3
thinking: medium
tools: read, edit, write, safe_bash, web_search
session-mode: lineage-only
auto-exit: true
---

You are a specialized agent that does X...
```

### Frontmatter reference

| Field | Type | Description |
| ----- | ---- | ----------- |
| `name` | string | Agent name (used in `agent: "my-agent"`) |
| `description` | string | Shown in `subagents_list` |
| `model` | string | Default model |
| `thinking` | string | `minimal`, `low`, `medium`, or `high` |
| `tools` | string | Strict tool allowlist. Built-ins: `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`. Extension-backed: `web_search`, `web_fetch`, `safe_bash`, `video_extract`, `youtube_search`, `google_image_search`. Only the extensions backing the listed tools are loaded into the child |
| `subagent_agents` | string | Comma-separated agent names this agent may spawn. **Presence of this field grants the spawning toolset** (`subagent`, `subagent_message`, `subagents_list`) and restricts spawn targets to the list. Omit it and the agent cannot spawn at all |
| `skills` | string | Comma-separated skill names to auto-load |
| `session-mode` | string | `standalone` (default), `lineage-only`, or `fork` — see below |
| `system-prompt` | string | `append` or `replace`: pass the body as the child's `--append-system-prompt` / `--system-prompt`. Omit and the body is prepended to the task prompt instead |
| `auto-exit` | boolean | Auto-shutdown when the agent finishes (see below) |
| `interactive` | boolean | Whether stall/recovery transitions wake the parent (see below) |
| `cwd` | string | Default working directory |
| `disable-model-invocation` | boolean | Hide from `subagents_list`; still spawnable by explicit name |
| `cli` | string | `claude` runs the agent via the Claude Code CLI instead of pi |

### session-mode

- `standalone` — fresh session, no lineage link to the caller (default)
- `lineage-only` — fresh session with `parentSession` linkage for discovery/fork UX, but no copied turns
- `fork` — child session seeded with the caller's conversation context

### auto-exit

With `auto-exit: true`, the session shuts down when the agent's turn ends — the agent just writes its final message and stops (there is no "done" tool). The last assistant message becomes the summary returned to the parent. Recommended for all autonomous agents.

Notes:

- **Manual input does not strand an auto-exit sub-agent.** If a human types into the pane, the session still closes once that turn completes normally — only an escape/abort leaves it open.
- **Auto-exit is suppressed while work is in flight:** the session parks as `waiting` instead of exiting when an `ask_question` is still unanswered, or when the agent's own child sub-agents are still running (a worker can stop after dispatching children and stays open until the last result returns).

### interactive

Controls whether `stalled`/`recovered` status transitions send a steer message to the parent session. Defaults to the inverse of `auto-exit`: autonomous agents get stall pings; user-driven agents stay quiet (the user is already working in that pane — the widget still updates). Set explicitly to override.

## Tool access control

Access is **whitelist-only**. Every sub-agent process is launched with `--no-extensions` (extension discovery disabled) and `--tools <allowlist>`; only the extensions backing the listed tools are loaded back in explicitly. There is no default toolset and no deny-list — an agent gets exactly what its frontmatter lists. The restriction survives resume via the loadout snapshot.

Spawns must name a known agent at **every** depth. A top-level session may spawn anything discoverable; a sub-agent may only spawn the agents in its `subagent_agents` list (enforced via `PI_SUBAGENT_ALLOWED`). There is no agentless spawn route, so a child can never escalate to a full-toolset profile by omitting its agent.

Extensions can register additional tools for sub-agents at runtime via `registerToolExtension(name, path)` on the `__pi_interactive_subagents` process global.

## Role folders

`cwd` starts a sub-agent in a directory with its own config, so role-specific setups (CLAUDE.md, skills, extensions) apply:

```
project/
└── agents/
    ├── game-designer/   ← CLAUDE.md, .pi/…
    └── sre/             ← CLAUDE.md, .pi/…
```

```typescript
subagent({ agent: "worker", cwd: "agents/sre", task: "Review the deployment pipeline" });
```

Set a per-agent default with `cwd:` in frontmatter.

## Status widget & configuration

The widget tracks each sub-agent from a runtime activity snapshot written by the child: `starting`, `active` (turn/provider/tool work), `waiting` (open for input or another stage), `stalled` (no valid snapshot for too long), or `running` (fallback). Sub-agent sessions also show their own tools widget — toggle it with `Ctrl+Alt+O`. Completion messages expand with `Ctrl+O`.

Status display is configured via `config.json` in the extension directory (copy `config.json.example`; it's gitignored):

```json
{
  "status": { "enabled": true }
}
```

## Mux Configuration

The multiplexer is selected at startup based on `PI_SUBAGENT_MUX`:

| Value | Behaviour |
| ----- | --------- |
| `PI_SUBAGENT_MUX=wezterm` | Force WezTerm surface (Windows 10/11) |
| `PI_SUBAGENT_MUX=tmux` | Force tmux surface (POSIX) |
| `PI_SUBAGENT_MUX=auto` | Auto-detect: `$WEZTERM_PANE` wins over `$TMUX` when both are set |
| *(unset)* | Same as `auto` — `$WEZTERM_PANE` takes precedence |

Auto-detection precedence when both `$WEZTERM_PANE` and `$TMUX` are set:
1. `$WEZTERM_PANE` is preferred (WezTerm on Windows).
2. `$TMUX` is the fallback (tmux on POSIX).

Use `PI_SUBAGENT_MUX=tmux` to override and force tmux even when both are set.

Mux availability requires: env-var set, binary on PATH, and liveness probe (memoized per module load). All three checks run once per module load and are memoized. Failure marks the mux as `available: false` with the per-check breakdown visible in diagnostics.

## Smart BSP Auto-Balancing

When running under WezTerm, the extension picks the optimal pane to split using a smart BSP (binary space partition) heuristic rather than always splitting the parent pane. This keeps the layout balanced as the pane tree grows.

The algorithm (`selectSplitTarget` in `wezterm.ts`):

1. **Same-tab guard:** Only panes in the parent's tab are considered. A pane in a different tab is never selected.
2. **Largest-area wins:** The pane with the greatest `rows × cols` area is the split target. On an area tie, the first entry in `wezterm cli list` Z-order wins; if the parent is among the tied panes it is preferred so the split stays in place.
3. **Direction by aspect ratio (2:1 rule + 80-column floor):**
   - If `cols >= rows * 2` **and** `cols >= 80` → split `--right` (add width to a wide layout).
   - Otherwise → split `--bottom` (add height to a tall layout).

The 80-column floor prevents a narrow-but-wide pane (e.g. a terminal with very few rows) from being treated as "wide enough" just because `cols >= rows * 2` holds. The result is a self-balancing pane tree that avoids degenerate 1-row-high splits.

The design artifact for this heuristic is `research/pane-split-target.html` — a browser-based throwaway prototype with six guided walkthroughs covering single-pane, parent-largest, other-largest, cross-tab, square-pane, and deeply-nested scenarios.

## Requirements

- [pi](https://github.com/badlogic/pi-mono)
- [tmux](https://github.com/tmux/tmux)
- [wezterm](https://wezterm.org/) — terminal multiplexer for Windows (requires `wezterm` CLI on PATH)
- [pwsh](https://github.com/powershell/powershell) — PowerShell 7+ for WezTerm long-command launcher mechanics
- [Windows 10/11] — WezTerm is the primary multiplexer on Windows; tmux is primary on POSIX

```bash
tmux new -A -s pi 'pi'
```

## Model Inheritance (Ticket 8 / Issue #9)

The `resolveEffectiveModel` function resolves the model loadout in this 4-tier priority order:
1. **Explicit `params.model`** — caller-provided override in the `subagent()` call.
2. **Agent frontmatter `model`** — the `model:` field in the agent's `.md` definition.
3. **Parent context `ctx.model`** — inherited provider/id from the parent session (e.g. `openrouter/z-ai/glm-5.2`).
4. **`undefined`** — when no source resolves, the model is unset and the child inherits whatever default the pi runtime supplies.

This is enforced at spawn time and replayed on resume via the loadout snapshot (`<session>.loadout.json`), so a resumed session always gets the same model it started with.

## Architecture References

- [ADR 0001](docs/adr/0001-mux-dispatcher.md) — Mux dispatcher architecture: `PI_SUBAGENT_MUX` precedence, auto-detect, and mux availability.
- [ADR 0002](docs/adr/0002-wezterm-e2e-verification.md) — End-to-end verification: `npm test` (227 unit tests), `npm run test:wezterm` (WezTerm surface integration), and `npm run test:integration:all`.
- `research/pane-split-target.html` — Smart BSP auto-balancing design artifact for WezTerm `selectSplitTarget`.

## Developer Instructions

Run the test suite:
- `npm test` — runs 227 unit tests (tmux surface + WezTerm surface + session model inheritance)
- `npm run test:wezterm` — runs WezTerm surface integration tests (requires WezTerm on Windows)
- `npm run test:integration:all` — runs all integration tests

## Acknowledgements

Forked from [HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents), which originated the subagent architecture, the multi-multiplexer surface layer, and the status widget; its supervision features were inspired by [RepoPrompt](https://repoprompt.com/).

## License

MIT
