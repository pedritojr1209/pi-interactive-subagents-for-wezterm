## Environment & Terminal Constraints

- **OS:** Windows
- **Terminal:** WezTerm
- **Shell:** PowerShell
- **Installed Search Tools:** `rg` (ripgrep) and `fd` are installed and available in PATH.
- **Rules for Terminal Tool Calls:**
  - Execute commands using **PowerShell** syntax (e.g., use `$env:VAR = "value"` instead of `export`, `Test-Path` / `Get-ChildItem` instead of `find`, `Select-String` or `rg` instead of Linux `grep`).
  - Terminal is **WezTerm** on Windows: respect Windows file path conventions (`\`, drive letters like `C:\`, `G:\`).
  - Do not use interactive shell commands that hang without a pseudo-terminal unless specifically requested.

## Agent skills

### Issue tracker

GitHub Issues via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default canonical vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

