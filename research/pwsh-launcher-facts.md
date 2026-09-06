# pwsh launcher facts (Windows + WezTerm)

Primary-source notes for the subagent long-command launcher path used on
Windows. Reference for Ticket 4 (research), Ticket 7 (Issue #8), and any
future launcher work. Authoritative against `pwsh 7.x`; pwsh 5.x differences
called out where they matter.

## Tokenizer (the only thing that matters)

`pwsh -NoProfile -ExecutionPolicy Bypass -File <PATH>` parses the PATH
argument as a *single token*, not via cmd.exe and not via the host shell.

| Char | Behavior in `-File` mode | Action |
| --- | --- | --- |
| ` ` (space) | Stays literal as long as the whole PATH is one argv element. Wrap in single quotes when sourcing from a variable. | `'…'` |
| `'` | Closes a single-quoted pwsh string. | Double to `''`. |
| `$` | Active inside double-quoted pwsh strings (variable expansion). | Use single quotes to neutralize. |
| `` ` `` | Active inside double-quoted pwsh strings (subexpression). | Use single quotes to neutralize. |
| `\` | Escape character in double-quoted pwsh strings. | Use single quotes to neutralize. |
| `\n`, `\r`, `\t` | Newline / CR / tab. We never embed these in a path. | n/a |

The launcher's invocation is therefore
`pwsh -NoProfile -ExecutionPolicy Bypass -File '<PATH>'` with `'` doubled.

## Line endings

`pwsh -File` accepts both LF and CRLF scripts. We write LF-only because
`writeFileSync(..., "utf8")` defaults to LF and there is no platform reason
to introduce CRLF on Windows.

## Extension requirement

`pwsh -File` **requires** a `.ps1` extension. Any other extension produces:

> The argument to the -File parameter does not end with the .ps1 extension.

Existing callers in `pi-extension/subagents/index.ts` pass
`options.scriptPath` ending in `.sh` (the POSIX launcher extension). The
Windows launcher (`wezterm.ts:sendLongCommand`) coerces that to `.ps1`
before invoking `pwsh -File`. See `coercePwshScriptPath` in `wezterm.ts`
and its unit tests.

## Sentinel

`Write-Output "__SUBAGENT_DONE_$LASTEXITCODE__"` as the last statement of
the script. `$LASTEXITCODE` is the exit code of the last *native* command,
which under `-File` mode is the script's overall exit. `wezterm cli
get-text` reads the success stream as plain text, so the regex
`/__SUBAGENT_DONE_(\d+)__/` parses it the same way `tmux.ts:readScreen`
parses the bash sentinel.

## Caller-emitted env prefix

POSIX bash uses `NAME=value cmd …`. pwsh uses `$env:NAME = "value"; cmd
…` (semicolon-terminated assignment). Today the callers in `index.ts`
emit bash-style env prefixes; pwsh tolerates them as bare strings because
the parts get joined with spaces and the leading `=`-syntax is parsed by
pwsh as an *expression* of the form `<bare-word>=<bare-word>` which
evaluates to a comparison string and is then ignored. This is fragile and
documented here as a follow-up, not silently relied on.

## What is NOT covered here

- `ExecutionPolicy` of `RemoteSigned` vs `Bypass`: we always pass `-Bypass`,
  intentionally. The user can override in the `.ps1` directly.
- `NoProfile`: required so a stale `Microsoft.PowerShell.Archive` error
  from `$PROFILE` cannot break the launcher.
- pwsh 5.1 (Windows PowerShell, the legacy default) differences: the same
  tokenizer applies, but `Get-Date` formatting differs — irrelevant here
  because we don't emit dates in the invocation.
- `pwsh` not on PATH: out of scope; this is a host installation concern,
  not a launcher concern. A missing `pwsh` produces a recognizable error
  in the pane and is caught by `pollForExit`'s screen-reader fast path.