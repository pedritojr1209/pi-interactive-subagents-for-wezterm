# Mux dispatcher architecture

The extension's multiplexer handling moves from a hardcoded tmux-only
surface (`tmux.ts`) to a dispatcher that selects between `tmux.ts` and
`wezterm.ts` at module load, with `PI_SUBAGENT_MUX` as the only runtime
override. The rest of the extension imports the nine surface names from
`mux.ts` and never reaches into a per-mux module directly.

Auto-detect precedence when `PI_SUBAGENT_MUX=auto` (or unset): if both
`$WEZTERM_PANE` and `$TMUX` are set, `$WEZTERM_PANE` wins. The override
applies after this tie-breaker, so `PI_SUBAGENT_MUX=tmux` still wins when
both env vars are present.

"Mux is available" requires three checks: env-var set, binary on PATH,
and a liveness probe (`tmux list-panes` for tmux; `wezterm cli list`
for wezterm). All three run once per module load and are memoized.
Failure marks the mux as `available: false` with the per-check
breakdown in `_muxAvailability()` so the error message can name which
check failed.

The public API stays `isMuxAvailable(): boolean`. The richer per-mux
detail lives in the underscore-prefixed `_muxAvailability()` for
diagnostics and unit tests, following the same convention as
`__pollForExitTest__` in `tmux.ts`.

Considered alternatives:

- **Tmux-only, with WezTerm as a follow-on**: rejected — the chart's
  destination is "runs on Windows + WezTerm + native pwsh," which
  isn't reachable without the abstraction.
- **Boolean PI_SUBAGENT_MUX (no `auto`)**: rejected — users with
  neither env var set would get a hard-fail instead of the existing
  graceful tmux hint.
- **Per-call re-resolution of the active mux**: rejected — pollers
  that captured a surface id earlier in the session would silently
  switch mux operations if the env flipped, which is unsafe.
- **Liveness check at first `createSurface()` instead of module
  load**: rejected — pushes the diagnostic burden to the call site
  and makes startup error paths harder to test.

This is locked by [#2](../../issues/2); see its resolution comment for
the full decision set and cascade into Tickets 3, 6, and 10.