# Ticket 6 — Canonical source of "the parent pi's active model"

Scope: pick a single, zero-side-effect, reliably-available value so `effectiveModel`
at `pi-extension/subagents/index.ts:1177` can default to it when both
`params.model` and `agentDefs.model` are unset. Per the chart, when the parent
model can't be determined, omit `--model` and let pi pick its own default
(no hard-fail, no warning).

Sources verified against `@earendil-works/pi-coding-agent` (the live name of
the package; the npm `mariozechner/pi-coding-agent` redirect points there).
Source-of-truth files:

- `packages/coding-agent/src/core/extensions/types.ts` — `ExtensionContext`
  and event union.
- `packages/coding-agent/docs/extensions.md` — public extension API docs
  (sections "ExtensionContext → ctx.modelRegistry / ctx.model /
  ctx.thinkingLevel" and "Model Events → model_select").
- `packages/coding-agent/docs/session-format.md` — JSONL entry schema.
- `packages/coding-agent/docs/cli-reference.md` and the npm README — CLI
  flags + environment variables.

## Candidate 1 — `process.env.PI_MODEL` / `PI_DEFAULT_MODEL` / similar

**Verdict: no such env var exists.** The only `PI_*` env vars pi honours at
startup (per the CLI Reference and README) are:

- `PI_CODING_AGENT_DIR` — override config dir (`~/.pi/agent`).
- `PI_CODING_AGENT_SESSION_DIR` — override session dir (overridden by
  `--session-dir`).
- `PI_PACKAGE_DIR` — override package dir (Nix/Guix tokenisation).
- `PI_OFFLINE` — disable startup network ops.
- `PI_SKIP_VERSION_CHECK` — skip the `pi.dev` version ping.
- `PI_TELEMETRY` — opt in/out of install telemetry.
- `PI_CACHE_RETENTION` — Anthropic 1h / OpenAI 24h cache hint.

None of these export the active model. The parent does not propagate its
model to children through env vars, and there is no documented convention
to read one.

The extension already injects its own `PI_SUBAGENT_*` env vars into the
subagent command (`PI_SUBAGENT_PARENT_SESSION_ID`,
`PI_SUBAGENT_NAME`, `PI_SUBAGENT_ALLOWED`, `PI_SUBAGENT_ID`,
`PI_SUBAGENT_MUX`, `PI_SUBAGENT_AGENT`, etc.). The cleanest place to
hand the parent model across is therefore one of those, injected at spawn
time from `ctx.model`.

## Candidate 2 — Parent session jsonl (`ctx.sessionManager.getSessionFile()`)

**Verdict: reliable as a fallback but not preferred.** The session file
schema (Session Format doc) gives us:

- The last assistant message on the active branch carries `provider` and
  `model` strings.
- Explicit `model_change` entries are written whenever the user picks a
  new model via `/model` or Ctrl+P cycling. To recover the *current* model
  you walk the active branch from the leaf back to root and apply
  `model_change` overrides on top of the last assistant message's `model`
  field. SessionManager exposes `buildSessionContext()` which already
  does exactly this — it returns `messages`, `thinkingLevel`, and `model`
  in one call.

Failure modes:

- **Session file empty / not yet written** (`--no-session`, in-memory
  sessions, right at session_start before any assistant message):
  `getSessionFile()` may return `null`, and even when it returns a path
  the file may be empty until the first persisted entry. Both are
  reachable in practice: `-c` on a fresh install, `--no-session`,
  `--fork` of a brand-new session, and the very first turn after
  `/new`. In all of these there is no historical `model` to read.
- **Branching**: a `model_change` entry sitting on an abandoned branch
  must not be counted. Walking the active branch from the leaf (the
  approach `buildSessionContext()` already implements) is the correct
  algorithm.
- **Side effect**: none — the read is a pure JSONL parse.

So: safe and authoritative *after* the first assistant message lands on
the active branch, but unreliable at the moment we need it (subagents are
spawned from the tool handler, which fires while the parent's first or
Nth assistant turn is in progress — at that point the active branch ends
in a user/tool_result entry, not an assistant one). This makes it a
fallback, not the primary source.

## Candidate 3 — `ExtensionContext` callback at session_start (and beyond)

**Verdict: this is the canonical source.** `ExtensionContext` exposes
two relevant fields, both available in every event handler and command
throughout the session:

```ts
// packages/coding-agent/src/core/extensions/types.ts
export interface ExtensionContext {
    ...
    /** Current model (may be undefined) */
    model: Model<any> | undefined;
    /** Current thinking level, when provided by the session runtime. */
    thinkingLevel?: ThinkingLevel;
    ...
}
```

`Model<any>` is the resolved `pi-ai` model object with `provider`,
`id`, `name`, `contextWindow`, etc. already populated. It tracks the
*active* model, meaning the result of the most recent `/model` /
Ctrl+P cycle / session restore — not the persisted default for new
sessions.

The current value is kept in sync by the runtime; extensions don't need
to subscribe. For extensions that *want* a notification, the
`model_select` event fires on every change with `{ model, previousModel,
source: "set" | "cycle" | "restore" }` — `source: "restore"` is exactly
the session-replay path this extension cares about.

Coverage of the `model: undefined` window:

- The type is `Model<any> | undefined`, so the runtime does not
  promise a defined model in every context. Practically it is defined
  by `session_start` (the runner resolves the default before
  extensions are notified — `resources_discover` already sees it; the
  subagent tool's `pi.registerTool(...).execute(...)` handler is
  invoked later in the same session lifecycle and always sees a
  defined `ctx.model`). The only realistic `undefined` case is during
  extension factory execution before the runner has bound its context,
  which is irrelevant here — subagent launches happen from the tool
  *execute* body, not from the factory.

Implementation note: `ctx.model.provider` + `ctx.model.id` is what pi's
own CLI accepts as `--model openai/gpt-4o` (the `provider/id` form
documented in the CLI Reference). For OpenRouter-style models where the
parent resolved to `openrouter/z-ai/glm-5.3`, the runtime `Model` keeps
the full path. The exact string we hand to the child is therefore the
concatenation we already pass through `params.model` from the agent
frontmatter today.

## Candidate 4 — `pi` binary introspection (`--print-default-model`,
`--show-active-model`)

**Verdict: no such flag exists.** The full CLI flag list (CLI Reference
+ `pi --help`) has nothing of the kind. The only model-related flags
are `--provider`, `--model`, `--api-key`, `--thinking`, `--models`, and
`--list-models`. A child process cannot introspect a parent's resolved
model via the binary without already passing it the same inputs that
resolved the parent's choice — which is exactly what `ctx.model` gives
us synchronously, with no `execFileSync` cost, no PATH assumption, no
`--print-default-model` to invent.

A `--session <id>` + parse approach would also work but inherits the
"empty branch / no messages yet" failure mode from Candidate 2 and adds
process spawn cost.

## Candidate 5 — Config-file conventions (`~/.pi/settings.json`,
`~/.pi/agent/*.md`, `ANTHROPIC_MODEL`, etc.)

**Verdict: wrong layer.** These describe the **configured default for
new sessions**, not the parent's *active* model. The parent may have
switched mid-session with `/model` or Ctrl+P — that change never writes
back to `settings.json` (the docs explicitly state: "Set the model for
the current session without changing the configured default for new
sessions"). So even reading the user's preferences file gives us a
strictly inferior answer to `ctx.model`, which already reflects any
in-session switches.

For completeness, pi's own precedence (CLI Reference) is roughly:
`--model`/`--provider` CLI flags > project `.pi/settings.json` >
`~/.pi/agent/settings.json` > provider catalogue default. None of those
exposes the in-session active model. Per-provider env vars
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …) are API-key only and never
select a model.

## Recommendation

Use **`ctx.model` captured at spawn time, snapshotted onto the
subagent command line as `--model <provider>/<id>`, and also written
into `SubagentLoadout.model` (session.ts:102)** so a `subagent_message`
resume replay sees the same model.

```ts
// At launchSubagent (pi-extension/subagents/index.ts:1177)
const explicitModel = params.model ?? agentDefs?.model;
const inheritedModel = ctx.model
    ? `${ctx.model.provider}/${ctx.model.id}`
    : undefined;
const effectiveModel = explicitModel ?? inheritedModel; // may be undefined

// … when building the child argv, only emit --model when defined:
const args = effectiveModel
    ? ["--model", effectiveModel, /* … */]
    : [/* … */];
```

And when serialising the loadout (`session.ts:96-117`):

```ts
const loadout: SubagentLoadout = {
    ...,
    model: effectiveModel ?? null, // null = "let pi pick its default"
    ...,
};
```

This is consistent with the chart's "omit `--model` and let pi pick its
own default (no hard-fail, no warning)" rule because `effectiveModel`
ends up `undefined` exactly when neither the agent frontmatter nor the
parent's runtime knows an answer (`ctx.model` is `undefined` in the
tool-execute window of an edge-case flow such as an extension that
called `ctx.shutdown()` between model resolution and tool execution —
the extension is shutting down and shouldn't be spawning subagents
anyway).

Why this beats the alternatives:

- **vs Candidate 2 (jsonl walk)**: same authoritative source once the
  branch has an assistant message, but `ctx.model` is available
  earlier (no wait for first assistant turn), is one property read
  instead of a JSONL parse, and never silently goes stale on a
  branch where the user just `/tree`'d back to before the first
  assistant message. If we ever wanted the JSONL form as belt-and-
  braces, `ctx.sessionManager.buildSessionContext()` already returns
  `model` — keep it as a fallback, but it should never be reached in
  practice.
- **vs Candidate 1 (env var)**: pi doesn't export one; we'd have to
  invent `PI_SUBAGENT_PARENT_MODEL`. We *could* do that for symmetry
  with the rest of `PI_SUBAGENT_*`, but the runtime already has the
  canonical value in `ctx.model`, and the spawn command is built
  inside the same process — passing it as an `--model` argv token is
  strictly simpler than passing it as an env var the child then has
  to parse.
- **vs Candidate 4 (binary introspection)**: non-existent flag, plus
  the cost of a child process to read what the parent already knows.
- **vs Candidate 5 (settings file)**: returns the configured
  *default*, not the parent's active choice. Wrong layer.

Failure modes and graceful degradation:

- `ctx.model` is `undefined` (documented possible but rare in the
  tool-execute context): fall through, omit `--model`, do not warn.
  Pi resolves its configured default. Matches the chart decision.
- The user runs the parent without a configured provider / API key:
  pi itself surfaces that error. Not our problem; inheriting the
  parent's model can't make it worse, and the child will see the same
  missing-auth failure when it tries to call the provider.
- The parent switches model mid-session after spawning: the
  *first* subagent keeps the model that was active at spawn
  (correct: that was the user's intent at that moment). Subsequent
  spawns pick up the new model. If we want to react to mid-session
  switches, subscribe to `model_select` and re-resolve at spawn time
  — already covered because `ctx.model` is read at spawn, not
  cached.
- Resume via `subagent_message({ sessionId })`: the loadout snapshot
  (`SubagentLoadout.model`) is replayed verbatim, so a resumed
  subagent always reuses the model its previous incarnation was
  running on — even if the parent has since switched. That is the
  desired invariant for a long-running subagent: a research agent
  started with model X should not silently flip to model Y just
  because the parent tab-cycled.
- Thinking level is not snapshotted (the ticket doesn't ask for it),
  but if a follow-up ticket wants the same treatment, the analogue is
  `ctx.thinkingLevel` at spawn → `SubagentLoadout.thinking`. Not
  blocking for this ticket.

Snapshotted-on-loadout answer: **yes**. The loadout snapshot exists
specifically so a resumed subagent gets the exact same sandbox it
originally ran with, independent of which model the parent happens to
be on now. Storing `effectiveModel` there (or `null` to mean "let pi
default") is consistent with how `toolAllowlist`, `cwd`, and `agentDir`
are already snapshotted.