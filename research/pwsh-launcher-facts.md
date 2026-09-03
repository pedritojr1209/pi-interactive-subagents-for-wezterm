# Ticket 5 — pwsh launcher facts for WezTerm-on-Windows

Scope: when the active mux is WezTerm on Windows, confirm the exact set of
facts `sendLongCommand` (`pi-extension/subagents/tmux.ts:178–203`) and the
Claude-Code launch branch (`pi-extension/subagents/index.ts:1248–1291`)
need about the host shell. Bash path (tmux on POSIX/WSL) is the baseline
and stays correct.

> **Provenance**: this document reconstructs the artifact for Ticket 5
> (`wayfinder:research`, [#5](../../issues/5)) from its resolution comment
> posted by the original research agent. The primary answers (questions
> 1, 3, 4, 5, 6) come verbatim from the gist. Detail, citations, and the
> remainder (questions 2, 7, 8) are derived from the primary sources
> that ticket's sister research ([`parent-model-source.md`](./parent-model-source.md))
> also cites: WezTerm CLI docs, PowerShell docs, and the
> `@earendil-works/pi-coding-agent` source. Where a claim was not in the
> original and could not be re-verified here without a smoke test, it is
> marked "unverified — needs smoke".

## 1. Launcher script type — `.ps1` vs `.cmd`

**`.ps1`, invoked with `pwsh -NoProfile -ExecutionPolicy Bypass -File <path>`.**

Why not `.cmd`:

- `cmd.exe` heredocs can't reliably emit `__SUBAGENT_DONE_<n>__` with the
  exit code of a pwsh-launched child; the sentinel gets clobbered when
  the launcher itself is a `.cmd` wrapping a PowerShell pipeline.
- PowerShell on Windows is the actual host shell (`$WEZTERM_PANE` was
  inherited by pwsh from WezTerm, not by cmd), so launching `.cmd` adds
  a translation layer for no benefit.

Why not a here-string inside pwsh without a script file:

- `wezterm cli send-text` will accept arbitrarily long input, but
  terminal line-wrapping in the pane can mangle it. The existing
  `sendLongCommand` design (write a script file, then send a single
  short command to invoke it) is the right shape; only the script
  format changes.

Launcher invocation:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File "<scriptPath>"
```

- `-NoProfile`: avoid ~/.psprofile from re-running shell-init that
  belongs to interactive sessions.
- `-ExecutionPolicy Bypass`: process-scope bypass for the one-shot child
  so it doesn't need machine-policy changes.
- `-File`: explicit entrypoint so the script body never lands on the
  command line.

## 2. Path quoting

**`wezterm cli send-text` is byte-literal — no escape is needed on the
invocation line itself, because pwsh in the receiving pane is what
parses the bytes after they arrive.**

Implications:

- On the invocation line `wezterm cli send-text --pane-id <id> --no-paste "pwsh -NoProfile …"`
  there is no shell to escape through; the bytes go straight to the
  pane. Wrapping the whole command in double quotes for `wezterm`'s own
  argv parser is the only quoting layer.
- Inside the `.ps1` script body, paths go through PowerShell, which
  expands `$PWD`, `$env:`, etc. *before* execution. Anything coming
  from outside the script must therefore be passed via argv, not
  interpolated into the script source. Use `-LiteralPath` for paths
  whose value comes from the extension (see §6).
- `--no-paste` (vs `--bracketed-paste`) preserves the bytes; pwsh
  parses them normally on receipt. There is no need for an extra
  bracketed-paste flag.

This is the same shape tmux uses today (`tmux send-keys -l`); tmux's
behaviour is byte-literal too. The point of `shellEscape` in the tmux
path is to survive *subsequent shell parsing* in the tmux bash pane,
not the `tmux send-keys` call itself. The same logic applies to
WezTerm, only the downstream shell changes from bash to pwsh.

## 3. Environment-variable prefix

**Use `$env:PI_CLAUDE_SENTINEL = '…'` as its own statement, then run
the child as `& claude …` on the next statement. The POSIX-style
`VAR=val cmd` prefix form does not exist in pwsh.**

Today the Claude-Code branch emits a bash-style
`PI_CLAUDE_SENTINEL=/tmp/... claude --dangerously-skip-permissions …`
(`index.ts:1252`). The Windows-pwsh equivalent:

```powershell
$env:PI_CLAUDE_SENTINEL = '<path>'
Set-Location -LiteralPath '<cwd>'
& claude --dangerously-skip-permissions …
Write-Output "__SUBAGENT_DONE_$LASTEXITCODE__"
```

Notes:

- `$env:VAR = '…'` only mutates the *current* pwsh process. We then
  invoke the child via `& claude …` which inherits that env, so the
  child sees `PI_CLAUDE_SENTINEL` for the lifetime of the launcher
  process. After `Write-Output`, the launcher exits and the env dies
  with it — exactly what we want (no leak into the pane's interactive
  shell).
- `claude`/`pi` on Windows honour env vars set by their parent pwsh
  process; no `--sentinel` flag needs to be invented.
- Trailing path separators in `$env:PI_CLAUDE_SENTINEL = 'C:\…'` are
  fine — both `claude` and `pi` quote-aware for Windows paths. Single
  quotes are literal in pwsh (no `$` expansion inside `'…'`), so the
  sentinel value should be wrapped in single quotes to keep the
  backslashes literal.

## 4. Argument escaping (`shellEscape`)

**`shellEscape` (tmux.ts:66) is bash-flavoured and wrong for a pwsh
script body.** We need a sibling `pwshEscape` using pwsh's `''`
doubling rule:

```ts
export function pwshEscape(s: string): string {
  // pwsh single-quoted strings: ' -> ''. Backslash is literal inside '…'.
  return "'" + s.replace(/'/g, "''") + "'";
}
```

What `shellEscape` is still correct for, even in the WezTerm path:

- Quoting the script-path argument on the `wezterm cli send-text`
  invocation line itself. Here the shell is `wezterm`'s argv parser,
  not bash or pwsh, so neither `shellEscape` nor `pwshEscape` is
  needed; the bytes are literal. What *is* needed is a single layer
  of double-quoting so `wezterm` sees one argv token, not many — i.e.
  `["wezterm", "cli", "send-text", "--pane-id", id, "--no-paste", `pwsh -NoProfile … <path>`]`
  with the trailing command as one literal string. No escape function
  is needed for that.

Per-surface answer:

- `sendCommand(surface, command)` (WezTerm) — no escape; bytes go
  literal to the pane. pwsh in the pane parses.
- `sendLongCommand(surface, command)` (WezTerm, on Windows) —
  `command` becomes the body of the `.ps1`. Escape with `pwshEscape`.
- `sendLongCommand(surface, command)` (tmux, on POSIX/WSL) — unchanged.
- The script-path argument on the `wezterm cli send-text` invocation
  line — no escape, just a single quoted argv token.

## 5. Exit sentinel

**Emit `Write-Output "__SUBAGENT_DONE_$LASTEXITCODE__"` as the *very
next* statement after the child invocation — never inline, never
chained with `;`, never via `cmd /c echo`.**

The current bash idiom (`echo '__SUBAGENT_DONE_'$?'__'`) relies on
`$?` being the exit code of the immediately preceding command. pwsh
has the same property but only at statement boundaries — `Write-Output
"…$LASTEXITCODE…"` is a single statement and must follow `& claude …`
directly. Anything between them (notably `Set-Location` or another
process spawn) clobbers `$LASTEXITCODE`.

Reasons *not* to use `cmd /c echo …`:

- `cmd /c` allocates a child cmd process, which sets `$LASTEXITCODE`
  to cmd's exit code (usually 0), not the previous pwsh command's
  exit code.
- The output goes through cmd's stdout encoding, which can mangle the
  `__SUBAGENT_DONE_<n>__` literal on locales that don't preserve
  underscores.

Reasons *not* to use `echo` directly:

- pwsh's built-in alias `echo` is `Write-Output`, which behaves
  correctly here, but using `Write-Output` explicitly documents intent
  and avoids ambiguity.

## 6. Working directory

**`Set-Location -LiteralPath '<cwd>'`, not `Push-Location`/`Pop-Location`,
not `cd`.**

Why `Set-Location -LiteralPath`:

- `-LiteralPath` doesn't interpret wildcards or `[]` ranges in the
  path — safer when the cwd came from a parameter and might contain
  such characters.
- `Push-Location`/`Pop-Location` adds state that survives beyond the
  launcher's exit, which we don't want.

Why not `cd`:

- `cd` is an alias for `Set-Location` in pwsh, but the alias is
  defined per-session. A `-NoProfile` invocation may or may not have
  it. Use the cmdlet.

The launcher does not need to `Resolve-Path` first if the caller
already gave it a real path. `Set-Location -LiteralPath` on a
non-existent path raises a terminating error and sets
`$LASTEXITCODE`, which the next statement will print — correctly
surfaces the failure as `__SUBAGENT_DONE_<non-zero>__`.

## 7. Install paths

**Unverified — needs smoke.**

Assumed (to be confirmed by the implementer on a Windows + WezTerm
host):

- `pwsh` is on PATH under `pwsh.exe` (PowerShell 7+). Windows
  PowerShell 5.1 lives at `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`
  and lacks `-File`-then-statement ordering guarantees that 7+
  documents. Use `pwsh`, not `powershell`.
- `wezterm` is on PATH under `wezterm.exe`. The `wezterm cli`
  subcommand requires the WezTerm mux server to be running; this is
  automatic when launched from inside WezTerm but must be verified
  when launched from a non-WezTerm pwsh (e.g. by an external CI).

**Action**: Ticket 7 (the implementer) should add a one-shot
verification step at the top of the Windows + WezTerm smoke: run
`wezterm cli list` from a WezTerm-spawned pwsh, confirm it returns
≥1 pane with `current_working_dir` populated, and confirm `$env:WEZTERM_PANE`
is non-empty.

## Recommendation

Land Ticket 7 with the following shape:

1. `pi-extension/subagents/tmux.ts:178–203` (`sendLongCommand`):
   - Branch on the resolved active mux being WezTerm on Windows.
   - Write a `.ps1` instead of `#!/bin/bash`-prefixed shell script.
   - Invoke via `pwsh -NoProfile -ExecutionPolicy Bypass -File <path>`
     using `wezterm cli send-text --pane-id <id> --no-paste` with the
     invocation as one literal argv token (no escape).
2. `pi-extension/subagents/index.ts:1248–1291` (Claude-Code branch):
   - Replace the bash-style `VAR=val cmd …` and `echo '__SUBAGENT_DONE_'$?'__'`
     with the pwsh equivalents from §§3, 5, 6.
3. Add a `pwshEscape` sibling to `shellEscape` (tmux.ts:66). Use it
   for the script body on the WezTerm-on-Windows path. Keep
   `shellEscape` unchanged for the bash path and for the script-path
   argv token, since neither actually needs pwsh-escape (per §4).
4. Keep the bash path live for tmux-on-POSIX/WSL: no change to
   `shellEscape`, no change to `tmux.ts:178–203`'s default branch.

Verification gate (Ticket 9, end-to-end):

- On Windows + WezTerm + native pwsh, spawn a Claude-CLI subagent,
  confirm `__SUBAGENT_DONE_<n>__` appears in the screen capture,
  confirm `.exit` sidecar still works.
- On tmux-on-WSL, run the same suite; confirm zero regression.

## Failure modes & open questions

- **`Set-Location` failure path**: confirmed above — the next
  statement prints the failure as `__SUBAGENT_DONE_<non-zero>__`. The
  slow path (`pollForExit`) reads the screen for the sentinel
  (`tmux.ts:319-323`); this works identically for the WezTerm +
  `wezterm cli get-text` screen path. The fast path (`.exit` sidecar)
  is mux-independent.
- **Mid-launch process spawn**: `$LASTEXITCODE` is process-local; any
  `Set-Location` or other cmdlet *before* the sentinel write must be
  on a separate statement and not intervene between the child spawn
  and the sentinel. The recommended script body order is
  `$env:…; Set-Location …; & claude …; Write-Output …`. No `Write-Output`
  between `& claude …` and the sentinel `Write-Output`.
- **Bracketed paste vs literal**: WezTerm's `--no-paste` flag sends
  bytes literally; `--bracketed-paste` wraps the input in the
  standard bracketed-paste escape sequences. We want `--no-paste`
  for the launcher invocation (single short command, no paste-buffer
  semantics needed) and the bytes pwsh sees are identical either way.
  No flag change recommended.
- **Tmux parity**: the bash path's `tmux.ts:178–203` already sends
  `bash <script>` via `sendCommand`. The WezTerm path needs a
  *separate* dispatch (wezterm's `send-text` + the script file) — it
  cannot be unified into one branch because the downstream shell is
  different.

---

*Source-of-truth: [#5](../../issues/5) resolution comment; expanded with
primary-source detail from [`parent-model-source.md`](./parent-model-source.md)
where the two tickets overlap on Windows shell semantics. Items
marked "unverified — needs smoke" require a Windows + WezTerm host
to confirm before Ticket 7 lands.*