/**
 * wezterm surface layer — companion of `tmux.ts` per ADR 0001.
 *
 * Mirrors the 9-name surface of `tmux.ts` (the baseline) using `wezterm cli`
 * subcommands:
 *
 *   tmux split-window -h -d -t <pane>      → wezterm cli split-pane --right --pane-id <id>
 *   tmux send-keys -t <pane> -l <cmd>      → wezterm cli send-text --pane-id <id> --no-paste "<cmd>\r"
 *       Enter
 *   tmux capture-pane -p -t <pane> -S -N   → wezterm cli get-text --pane-id <id> --start-line -N --end-line 0
 *   tmux kill-pane -t <pane>               → wezterm cli kill-pane --pane-id <id>
 *   tmux list-panes                        → wezterm cli list --format json
 *
 * ADR 0001 constraints honored:
 *   - Auto-detect precedence is handled by the dispatcher (`mux.ts`). This
 *     module exposes `isWeztermAvailable()` as its per-mux availability probe.
 *   - "Available" requires three checks: `$WEZTERM_PANE` set, `wezterm` binary
 *     on PATH, and `wezterm cli list` liveness. All three run once per module
 *     load and are memoized. Failure returns `available: false` with per-check
 *     breakdown in `_weztermAvailability()` (analogous to `__pollForExitTest__`).
 *   - Empty-string `$WEZTERM_PANE` → `available: false` (treated the same as
 *     unset; avoids a WezTerm mux server talking to itself).
 *   - Parent surface for `createSurface` defaults to `$WEZTERM_PANE` so the
 *     new pane follows the pi process rather than the user's focus.
 *
 * Windows / pwsh notes:
 *   - Argument arrays are used everywhere (no `shell: true`). On Windows this
 *     sidesteps MSYS/Cygwin PATH-translation surprises for `wezterm.exe` and
 *     `pwsh.exe`.
 *   - `sendLongCommand` writes a `.ps1` (coerced from a `.sh` script path if
 *     the caller still passes one — pwsh `-File` rejects non-`.ps1` paths)
 *     and invokes it as `pwsh -NoProfile -ExecutionPolicy Bypass -File '<path>'`.
 *     The single-quoted path neutralizes `$`, backtick, and embedded `'`
 *     inside the path so pwsh argument parsing sees it as one literal token.
 *     The trailing `Write-Output "__SUBAGENT_DONE_${LASTEXITCODE}__"` matches
 *     the bash `echo '__SUBAGENT_DONE_'$?'__'` sentinel used by `tmux.ts`.
 *     See `research/pwsh-launcher-facts.md` (Ticket 4) for the primary-source
 *     notes governing this launcher.
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { hasCommand } from "./command-available.ts";

const execFileAsync = promisify(execFile);

// ── Availability ──

export interface WeztermAvailability {
  available: boolean;
  envVar: { set: boolean; value: string };
  binary: { found: boolean; path?: string };
  liveness: { ok: boolean; error?: string };
}

let weztermAvailabilityMemo: WeztermAvailability | null = null;

export function _resetAvailabilityForTesting(): void {
  weztermAvailabilityMemo = null;
}

/**
 * Rich availability check: env-var set, binary on PATH, liveness probe.
 * Memoized for the lifetime of the module (per ADR 0001 "once per module
 * load"). Empty-string `$WEZTERM_PANE` counts as not-set — a WezTerm mux
 * server inside a non-WezTerm shell would set it to "" and we don't want
 * to mistake that for "we are inside WezTerm".
 */
export function _weztermAvailability(): WeztermAvailability {
  if (weztermAvailabilityMemo) return weztermAvailabilityMemo;

  const rawPane = process.env.WEZTERM_PANE ?? "";
  const envSet = rawPane.length > 0;
  const binaryFound = hasCommand("wezterm");

  let livenessOk = false;
  let livenessError: string | undefined;
  if (binaryFound) {
    try {
      execFileSync("wezterm", ["cli", "list", "--format", "json"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      livenessOk = true;
    } catch (err: any) {
      livenessOk = false;
      livenessError = err?.message ?? String(err);
    }
  }

  const result: WeztermAvailability = {
    available: envSet && binaryFound && livenessOk,
    envVar: { set: envSet, value: rawPane },
    binary: { found: binaryFound },
    liveness: { ok: livenessOk, error: livenessError },
  };
  weztermAvailabilityMemo = result;
  return result;
}

/**
 * True when running inside WezTerm with `wezterm.exe` on PATH and the mux
 * server responding. Mirrors `isTmuxAvailable()`: the dispatcher picks
 * between `isTmuxAvailable()` and `isWeztermAvailable()` via `$PI_SUBAGENT_MUX`.
 */
export function isWeztermAvailable(): boolean {
  return _weztermAvailability().available;
}

/**
 * Standalone "is some mux available" — this is the wezterm side of the seam,
 * so it returns `isWeztermAvailable()`. The dispatcher's `mux.ts` swaps this
 * to the per-mux implementation at module load.
 */
export function isMuxAvailable(): boolean {
  return isWeztermAvailable();
}

export function muxSetupHint(): string {
  return (
    "Start pi inside WezTerm on Windows (run `wezterm` then launch `pi` in its shell). " +
    "WezTerm sets $env:WEZTERM_PANE for every pane it spawns."
  );
}

function requireWezterm(): void {
  if (!isWeztermAvailable()) {
    const a = _weztermAvailability();
    const reasons: string[] = [];
    if (!a.envVar.set) reasons.push("$env:WEZTERM_PANE is empty");
    if (!a.binary.found) reasons.push("wezterm.exe not found on PATH");
    if (!a.liveness.ok) reasons.push(`wezterm cli list failed: ${a.liveness.error ?? "unknown"}`);
    throw new Error(
      `wezterm is required for subagents (${reasons.join("; ")}). ${muxSetupHint()}`,
    );
  }
}

// ── Shell helpers ──

/**
 * PowerShell single-quoted string escape. Inside pwsh single quotes, `'` is
 * doubled to `''` and backslash is literal. This is the sibling of
 * `tmux.ts:shellEscape`, used by both the script body produced in
 * `sendLongCommand` and the invocation string (`pwsh -File '<path>'`).
 * Exported so callers that build per-mux command parts (e.g. the dispatcher
 * tests) can use the same escape rules.
 */
export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "''") + "'";
}

// ── Bash → pwsh translation ─────────────────────────────────────────────────
// `index.ts:launchSubagent` builds a single bash-style command string with
// POSIX env-var prefixes (`KEY='val'`) and a `cd '<path>' &&` prefix, plus
// a trailing bash sentinel. `sendLongCommand` writes this verbatim into a
// `.ps1` for pwsh, so we translate here. Commands already in pwsh syntax
// (e.g. the integration-test harness emits `Set-Location 'x'; pi ...`)
// contain none of those bash idioms and pass through unchanged.

function isShellSpace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

function isAssignmentToken(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(value);
}

function readShellWord(s: string, i: number): { value: string; next: number } | null {
  while (i < s.length && isShellSpace(s[i])) i++;
  if (i >= s.length) return null;
  const start = i;
  let j = i;
  let value = "";
  while (j < s.length) {
    const ch = s[j];
    if (isShellSpace(ch)) break;
    if (ch === "'") {
      const close = s.indexOf("'", j + 1);
      if (close === -1) {
        value += s.slice(j + 1);
        j = s.length;
        break;
      }
      value += s.slice(j + 1, close);
      j = close + 1;
      if (s[j] === "\\" && s[j + 1] === "'") {
        value += "'";
        j += 2;
      }
    } else if (ch === '"') {
      const close = s.indexOf('"', j + 1);
      if (close === -1) {
        value += s.slice(j + 1);
        j = s.length;
        break;
      }
      value += s.slice(j + 1, close).replace(/\\(.)/g, "$1");
      j = close + 1;
    } else if (ch === "\\") {
      value += j + 1 < s.length ? s[j + 1] : "";
      j += 2;
    } else {
      value += ch;
      j += 1;
    }
  }
  return { value, next: j };
}

function tokenizeShell(
  s: string,
): Array<{ value: string; raw: string }> {
  const tokens: Array<{ value: string; raw: string }> = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && isShellSpace(s[i])) i++;
    if (i >= s.length) break;
    const ch = s[i];
    if (ch === ";") {
      tokens.push({ value: ";", raw: ";" });
      i++;
      continue;
    }
    if (ch === "&" || ch === "|") {
      const op = s[i + 1] === ch ? ch + ch : ch;
      tokens.push({ value: op, raw: op });
      i += op.length;
      continue;
    }
    const start = i;
    const r = readShellWord(s, i);
    if (!r) break;
    tokens.push({ value: r.value, raw: s.slice(start, r.next) });
    i = r.next;
  }
  return tokens;
}

/**
 * Translate a bash-style launch command (as built by `index.ts`) into
 * PowerShell statements for the `.ps1` script `sendLongCommand` writes.
 *
 * Conversions performed:
 *   - `cd '<path>' && `  →  `Set-Location -LiteralPath '<pwsh-escaped path>'`
 *   - `KEY='val'` / `KEY="val"` / `KEY=val` (leading env prefixes)
 *       →  `$env:KEY = '<pwsh-escaped val>'`
 *   - trailing `; echo '__SUBAGENT_DONE_'$?'__'` bash sentinel
 *       →  dropped (sendLongCommand appends its own `Write-Output` sentinel)
 *
 * Commands already in pwsh syntax (e.g. the integration-test harness emits
 * `Set-Location 'x'; pi -ne -e '...' 'task'`) contain no `cd ... &&` prefix,
 * no `KEY=val` prefix, and no bash sentinel, so they pass through unchanged.
 */
function bashToPwshParts(command: string): string[] {
  command = command.replace(/;\s*echo\s+['"]?__SUBAGENT_DONE_[\s\S]*$/, "");
  const out: string[] = [];
  const tokens = tokenizeShell(command);
  let idx = 0;

  // Lead with `cd '<path>' &&` if present.
  if (tokens[idx]?.value === "cd" && tokens[idx + 2]?.value === "&&") {
    const cwdPath = tokens[idx + 1]?.value ?? "";
    out.push(`Set-Location -LiteralPath ${shellEscape(cwdPath)}`);
    idx += 3;
  }

  // Consume leading env-var assignments: KEY='val' / KEY="val" / KEY=val.
  while (idx < tokens.length && isAssignmentToken(tokens[idx].value)) {
    const eq = tokens[idx].value.indexOf("=");
    const key = tokens[idx].value.slice(0, eq);
    const val = tokens[idx].value.slice(eq + 1);
    out.push(`$env:${key} = ${shellEscape(val)}`);
    idx++;
  }

  // Emit the remainder verbatim (preserving original quoting), stopping only
  // at the bash sentinel `; echo __SUBAGENT_DONE_...` that sendLongCommand
  // replaces with its own Write-Output. Other `;` separators (pwsh statement
  // separators) are kept.
  const cmdTokens: string[] = [];
  while (idx < tokens.length) {
    if (tokens[idx].value === ";") {
      const after = tokens[idx + 1]?.value;
      const markerArg = tokens[idx + 2]?.value ?? "";
      if (after === "echo" && markerArg.startsWith("__SUBAGENT_DONE_")) {
        break;
      }
    }
    cmdTokens.push(tokens[idx].raw);
    idx++;
  }
  if (cmdTokens.length > 0) {
    out.push(cmdTokens.join(" "));
  }
  return out;
}

// ── Parent surface ──

/**
 * The WezTerm pane the pi process lives in. Equivalent to tmux's `$TMUX_PANE`.
 * Exposed as a getter (rather than a constant) so it can be overridden in the
 * test harness if needed.
 */
export function parentPane(): string | undefined {
  const v = process.env.WEZTERM_PANE;
  return v && v.length > 0 ? v : undefined;
}

// ── Pane creation ──

/**
 * Map our 4-direction vocabulary onto wezterm's `--left/--right/--top/--bottom`.
 * Tmux uses `-h/-v/-b`; wezterm uses `--left/--right/--top/--bottom`. There
 * is no WezTerm CLI flag equivalent to tmux's `-b` (split-before), so "left"
 * and "up" both produce a new pane positioned before the source — that's
 * the closest semantic match in wezterm's flat flag space.
 */
function directionFlags(direction: "left" | "right" | "up" | "down"): string[] {
  switch (direction) {
    case "left":
      return ["--left"];
    case "right":
      return ["--right"];
    case "up":
      return ["--top"];
    case "down":
      return ["--bottom"];
  }
}

/**
 * Create a new subagent pane as a right split off the parent pi pane.
 * WezTerm panes are anonymous in the CLI (no per-pane title field), so the
 * `name` parameter is cosmetic only and is ignored — matching `tmux.ts`
 * where it is also unused. The pi process inside the pane sets its own
 * title via OSC escape sequences.
 */
export function createSurface(name: string): string {
  void name;
  return createSurfaceSplit(name, "right", parentPane());
}

/**
 * Create a new pane split in the given direction, optionally from a
 * non-parent source pane. Returns the new pane id as a string (WezTerm
 * pane ids are numeric, e.g. `"3"`, but we keep the surface handle as a
 * string everywhere — same as tmux's `%12` handles).
 */
export function createSurfaceSplit(
  name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
): string {
  void name;
  requireWezterm();

  const args: string[] = ["cli", "split-pane", ...directionFlags(direction)];
  if (fromSurface) args.push("--pane-id", fromSurface);

  const pane = execFileSync("wezterm", args, { encoding: "utf8" }).trim();
  if (!/^\d+$/.test(pane)) {
    throw new Error(`Unexpected wezterm split-pane output: ${pane}`);
  }
  return pane;
}

// ── Send ──

/**
 * Send a command string to a pane and execute it. `wezterm cli send-text`
 * sends bytes literally (`--no-paste` disables bracketed-paste wrap), so
 * special characters arrive unchanged — pwsh in the receiving pane parses
 * them as if typed. A trailing `\r` is appended so the command submits; tmux
 * needed two calls (`-l` then Enter), wezterm needs the carriage-return
 * inline. `\n` alone leaves the pane in a continuation-prompt state on
 * Windows.
 */
export function sendCommand(surface: string, command: string): void {
  requireWezterm();
  execFileSync(
    "wezterm",
    ["cli", "send-text", "--pane-id", surface, "--no-paste", command + "\r"],
    { encoding: "utf8" },
  );
}

/**
 * Send a long command by writing it to a `.ps1` script first. Avoids the
 * terminal-line-wrapping issues that break long commands sent character-
 * by-character through the pane, matching `tmux.ts:sendLongCommand`.
 *
 * On Windows + WezTerm, the launcher is:
 *     pwsh -NoProfile -ExecutionPolicy Bypass -File '<path>'
 * The path is pwsh-single-quoted (apostrophe doubled) so paths containing
 * `$`, backtick, or `\` survive pwsh argument parsing on Windows where
 * `$TMPDIR` / `$LOCALAPPDATA` may include them. `wezterm cli send-text`
 * delivers the invocation as literal bytes to the pane.
 *
 * `pwsh -File` requires a `.ps1` extension. Existing callers in index.ts
 * pass `options.scriptPath` ending in `.sh`; `coercePwshScriptPath` rewrites
 * a final `.sh` to `.ps1` so we don't break those callers. See Issue #8 /
 * Ticket 7 for the rationale.
 *
 * Script body is escaped with pwsh single-quote doubling (`shellEscape`) so
 * arbitrary paths/args coming from outside the script don't break parsing.
 * The trailing `Write-Output "__SUBAGENT_DONE_${LASTEXITCODE}__"` matches the
 * bash `echo '__SUBAGENT_DONE_'$?'__'` sentinel used by `tmux.ts`.
 */
export function sendLongCommand(
  surface: string,
  command: string,
  options?: { scriptPath?: string; scriptPreamble?: string },
): string {
  const scriptPath = coercePwshScriptPath(
    options?.scriptPath ??
      join(
        tmpdir(),
        "pi-subagent-scripts",
        `cmd-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.ps1`,
      ),
  );
  mkdirSync(dirname(scriptPath), { recursive: true });

  const scriptParts: string[] = [];
  if (options?.scriptPreamble) {
    scriptParts.push(options.scriptPreamble.trimEnd());
  }
  scriptParts.push(...bashToPwshParts(command));
  scriptParts.push('Write-Output "__SUBAGENT_DONE_${LASTEXITCODE}__"');

  writeFileSync(scriptPath, scriptParts.join("\n") + "\n", "utf8");

  sendCommand(surface, buildPwshInvocation(scriptPath));
  return scriptPath;
}

/**
 * Build the pwsh long-command invocation string. Single source of truth for
 * the launcher shape — `sendLongCommand` calls it, and the test seam exposes
 * it so unit tests can assert the exact bytes the pane will receive.
 */
function buildPwshInvocation(scriptPath: string): string {
  return `pwsh -NoProfile -ExecutionPolicy Bypass -File ${shellEscape(scriptPath)}`;
}

/**
 * `pwsh -File` rejects any path that does not end in `.ps1` with:
 *   "The argument to the -File parameter does not end with the .ps1 extension."
 * Existing callers in `index.ts` still pass `options.scriptPath` ending in
 * `.sh` (the POSIX launcher extension), so we rewrite a final `.sh` to
 * `.ps1` here. A path already ending in `.ps1` is returned unchanged; any
 * other trailing extension (`.txt`, `.sh.bak`, no extension at all) gets
 * `.ps1` appended so `pwsh -File` accepts it. This is intentionally narrow:
 * we only know about `.sh` and `.ps1` because those are the only extensions
 * the launchers emit or callers pass.
 *
 * Exported through the test seam (`__sendLongCommandTest__`) for unit tests.
 */
export function coercePwshScriptPath(scriptPath: string): string {
  if (/\.sh$/.test(scriptPath)) {
    return scriptPath.replace(/\.sh$/, ".ps1");
  }
  if (/\.ps1$/.test(scriptPath)) {
    return scriptPath;
  }
  return scriptPath + ".ps1";
}

/**
 * Test-only seam: lets unit tests assert the invocation string, script body,
 * and path coercion without running wezterm/pwsh. Mirrors `__pollForExitTest__`
 * in tmux.ts and `__sendLongCommandTest__` in tmux.ts. Production behavior
 * is unaffected.
 */
export const __sendLongCommandTest__ = {
  shellEscape,
  buildPwshInvocation,
  buildScriptBody(parts: readonly string[]): string {
    return parts.join("\n") + "\n";
  },
  bashToPwshParts,
  coercePwshScriptPath,
  directionFlags,
};

// ── Read screen ──

/**
 * Read the screen contents of a pane (sync). `wezterm cli get-text` returns
 * plain UTF-8 text, one terminal line per output line — parseable by the
 * same `__SUBAGENT_DONE_<n>__` regex the tmux path uses. Requires nightly
 * ≥ 20230320-124340-559cb7b0.
 */
export function readScreen(surface: string, lines = 500): string {
  requireWezterm();
  return execFileSync(
    "wezterm",
    [
      "cli",
      "get-text",
      "--pane-id",
      surface,
      "--start-line",
      String(-lines),
    ],
    { encoding: "utf8" },
  );
}

export async function readScreenAsync(surface: string, lines = 500): Promise<string> {
  requireWezterm();
  const { stdout } = await execFileAsync(
    "wezterm",
    [
      "cli",
      "get-text",
      "--pane-id",
      surface,
      "--start-line",
      String(-lines),
    ],
    { encoding: "utf8" },
  );
  return stdout;
}

// ── Close ──

/**
 * Close a pane. `wezterm cli kill-pane` requires nightly
 * ≥ 20230326-111934-3666303c. On Windows there is no equivalent to tmux's
 * `rebalanceSurfaces` (wezterm has no preset layouts); consecutive splits
 * stay evenly sized naturally because wezterm defaults each new split to
 * 50% of the source pane's space.
 */
export function closeSurface(surface: string): void {
  requireWezterm();
  execFileSync("wezterm", ["cli", "kill-pane", "--pane-id", surface], {
    encoding: "utf8",
  });
}

// ── Exit polling ──

export interface PollResult {
  reason: "done" | "sentinel" | "error";
  exitCode: number;
  errorMessage?: string;
}

/**
 * Interpret an `.exit` sidecar payload (written by the error path in
 * subagent-done.ts). Identical to `tmux.ts` — the `.exit` sidecar is mux-
 * independent (it's a regular file on disk), so only the slow-path screen
 * read changes between mux implementations.
 */
function interpretExitSidecar(data: any): PollResult {
  if (data?.type === "error") {
    const errorMessage =
      typeof data.errorMessage === "string" && data.errorMessage.trim() !== ""
        ? data.errorMessage
        : "Subagent exited with stopReason=error (no errorMessage in sidecar).";
    return { reason: "error", exitCode: 1, errorMessage };
  }
  return { reason: "done", exitCode: 0 };
}

export const __pollForExitTest__ = { interpretExitSidecar };

/**
 * Poll until the subagent exits. Fast path is the `.exit` sidecar (mux-
 * independent). Slow path reads the pane screen via `wezterm cli get-text`
 * and looks for the `__SUBAGENT_DONE_<n>__` sentinel — same regex as tmux.
 */
export async function pollForExit(
  surface: string,
  signal: AbortSignal,
  options: {
    interval: number;
    sessionFile?: string;
    sentinelFile?: string;
    onTick?: (elapsed: number) => void;
  },
): Promise<PollResult> {
  const start = Date.now();

  for (;;) {
    if (signal.aborted) {
      throw new Error("Aborted while waiting for subagent to finish");
    }

    if (options.sessionFile) {
      try {
        const exitFile = `${options.sessionFile}.exit`;
        if (existsSync(exitFile)) {
          const data = JSON.parse(readFileSync(exitFile, "utf-8"));
          rmSync(exitFile, { force: true });
          return interpretExitSidecar(data);
        }
      } catch {}
    }

    if (options.sentinelFile) {
      try {
        if (existsSync(options.sentinelFile)) {
          return { reason: "sentinel", exitCode: 0 };
        }
      } catch {}
    }

    try {
      const screen = await readScreenAsync(surface, 5);
      const match = screen.match(/__SUBAGENT_DONE_(\d+)__/);
      if (match) {
        return { reason: "sentinel", exitCode: parseInt(match[1], 10) };
      }
    } catch {
      if (options.sessionFile) {
        try {
          const exitFile = `${options.sessionFile}.exit`;
          if (existsSync(exitFile)) {
            const data = JSON.parse(readFileSync(exitFile, "utf-8"));
            rmSync(exitFile, { force: true });
            return interpretExitSidecar(data);
          }
        } catch {}
      }
    }

    const elapsed = Math.floor((Date.now() - start) / 1000);
    options.onTick?.(elapsed);

    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new Error("Aborted"));
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, options.interval);
      function onAbort() {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}