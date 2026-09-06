# ADR 0002: End-to-End Verification for WezTerm on Windows

## Status
Accepted (Codified in Ticket 9 / Issue #10)

## Context
Verify the complete WezTerm multiplexer integration lifecycle on Windows and codify it as automated tests that run against a live WezTerm CLI session when available, while degrading gracefully in headless CI.

### Environment
- Windows 10/11 Pro, native `pwsh` (PowerShell 7+)
- `wezterm` CLI on `PATH`
- `WEZTERM_PANE` set when running inside a WezTerm session

## Decision & Test Architecture
We structure testing into three tiers:

1. **Tier 1 — Unit Tests (`npm test`):**
   - 203 unit tests running via Node test runner.
   - Tests launcher command generation (`buildPwshInvocation`, `buildScriptBody`), path escaping, direction flags mapping, exit sidecar parsing, and dispatcher precedence without requiring a live multiplexer.

2. **Tier 2 — Surface Integration Suite (`npm run test:wezterm`):**
   - Implemented in `test/integration/wezterm-surface.test.ts`.
   - Exercises the 6 core surface operations against the live `wezterm` CLI: pane creation/splitting, text/screen capture (`get-text`), async screen reading, focus handling, long command `.ps1` execution with sentinel, and file operations.
   - Requires no LLM API keys; runs fast and free.

3. **Tier 3 — Lifecycle Integration Suite (`npm run test:integration:all`):**
   - Implemented in `test/integration/wezterm-lifecycle.test.ts`.
   - Verifies the full subagent session lifecycle through the `mux.ts` dispatcher.

## Consequences
- 100% backward compatibility with POSIX tmux behavior is preserved.
- Full Windows WezTerm verification is automated and repeatable locally via `npm run test:wezterm`.