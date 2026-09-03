# pi-interactive-subagents

A pi-coding-agent extension that spawns subagents in adjacent terminal-mux panes, observes their screen, and surfaces results in the parent. Multiplies the orchestrator across an arbitrary number of in-pane sub-sessions.

## Language

**Mux**:
The terminal multiplexer that owns the pane tree in which the parent pi process and its subagents live. Today the extension supports tmux and WezTerm; the central abstraction (`mux.ts`) makes adding another mux a matter of two new modules plus a dispatcher branch.
_Avoid_: terminal, session manager, pane tree owner

**Active mux**:
The mux the dispatcher resolved at module load, based on `PI_SUBAGENT_MUX` (override) and the auto-detect precedence (`$WEZTERM_PANE` wins over `$TMUX` when both are set). Memoized for the lifetime of the module instance.
_Avoid_: current mux, resolved mux, selected mux