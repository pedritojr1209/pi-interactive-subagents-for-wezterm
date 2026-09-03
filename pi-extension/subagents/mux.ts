/**
 * Mux dispatcher (ADR 0001).
 *
 * Re-exports the 9-name mux surface from either `tmux.ts` or `wezterm.ts`,
 * resolved once at module load based on `PI_SUBAGENT_MUX` (override) with
 * `$WEZTERM_PANE` > `$TMUX` auto-detection precedence. The rest of the
 * extension imports only from this file — the per-mux modules are private
 * implementation details.
 *
 * Selection precedence (per ADR 0001):
 *   1. `PI_SUBAGENT_MUX=wezterm|tmux` → use that mux.
 *   2. `PI_SUBAGENT_MUX=auto` (or unset) → if `$WEZTERM_PANE` is non-empty,
 *      wezterm wins; else if `$TMUX` is non-empty, tmux wins; else fall
 *      back to tmux (historical default).
 *   3. Any other value of `PI_SUBAGENT_MUX` is treated as `auto` (safely
 *     fallback per the user's required behavior).
 *
 * The override is applied AFTER the tie-breaker, so `PI_SUBAGENT_MUX=tmux`
 * still wins when both env vars are present.
 */
import * as tmux from "./tmux.ts";
import * as wezterm from "./wezterm.ts";

export type ActiveMux = "tmux" | "wezterm";

export type MuxSelectionSource =
  | "override"
  | "wezterm-env"
  | "tmux-env"
  | "auto-fallback";

export interface MuxAvailability {
  active: ActiveMux;
  source: MuxSelectionSource;
  /** True when the active mux is the one whose availability probe passes. */
  available: boolean;
  /** Echoes of the env-var probes (empty string when unset). */
  envVar: { wezterm: string; tmux: string };
  /** Echoed back when the user actually set `PI_SUBAGENT_MUX`. */
  piSubagentMux?: string;
}

function readEnvVar(name: string): string {
  const v = process.env[name];
  return v && v.length > 0 ? v : "";
}

let resolved: { active: ActiveMux; source: MuxSelectionSource } | null = null;

/**
 * Resolve the active mux for this process. Memoized for the lifetime of the
 * module instance — see `_resetMuxForTesting()` for the unit-test seam.
 */
export function getActiveMux(): { active: ActiveMux; source: MuxSelectionSource } {
  if (resolved) return resolved;

  const override = (process.env.PI_SUBAGENT_MUX ?? "auto").toLowerCase();
  if (override === "wezterm") {
    resolved = { active: "wezterm", source: "override" };
    return resolved;
  }
  if (override === "tmux") {
    resolved = { active: "tmux", source: "override" };
    return resolved;
  }

  // auto (or unknown value): tie-breaker picks wezterm over tmux when both
  // env vars are set; falls back to tmux when neither is set.
  const w = process.env.WEZTERM_PANE;
  const t = process.env.TMUX;
  if (w && w.length > 0) {
    resolved = { active: "wezterm", source: "wezterm-env" };
    return resolved;
  }
  if (t && t.length > 0) {
    resolved = { active: "tmux", source: "tmux-env" };
    return resolved;
  }

  resolved = { active: "tmux", source: "auto-fallback" };
  return resolved;
}

/** Reset memoized selection (unit-test seam only — never call from app code). */
export function _resetMuxForTesting(): void {
  resolved = null;
}

/**
 * Rich availability check: which mux was selected, how it was selected, and
 * whether the per-mux availability probe passes. Follows the same
 * underscore-prefixed convention as `__pollForExitTest__` in `tmux.ts` and
 * `_weztermAvailability()` in `wezterm.ts` for diagnostics + tests.
 */
export function _muxAvailability(): MuxAvailability {
  const { active: mux, source } = getActiveMux();
  const piRaw = process.env.PI_SUBAGENT_MUX;
  const tmuxAvail = tmux.isMuxAvailable();
  const wezAvail = wezterm.isMuxAvailable();
  return {
    active: mux,
    source,
    available: mux === "wezterm" ? wezAvail : tmuxAvail,
    envVar: {
      wezterm: readEnvVar("WEZTERM_PANE"),
      tmux: readEnvVar("TMUX"),
    },
    ...(piRaw !== undefined ? { piSubagentMux: piRaw } : {}),
  };
}

// ── Public surface (re-exported from the active mux) ──

/**
 * True when the active mux's per-mux availability probe passes.
 * Preserves the existing public signature.
 */
export function isMuxAvailable(): boolean {
  const { active } = getActiveMux();
  return active === "wezterm" ? wezterm.isMuxAvailable() : tmux.isMuxAvailable();
}

/** Setup hint for the active mux. */
export function muxSetupHint(): string {
  const { active } = getActiveMux();
  return active === "wezterm" ? wezterm.muxSetupHint() : tmux.muxSetupHint();
}

/**
 * The pane id of the process running pi (the agent's own pane).
 * Returns empty string `""` when not running inside a mux (root case).
 */
export function getParentSurfaceId(): string {
  const { active } = getActiveMux();
  return readEnvVar(active === "wezterm" ? "WEZTERM_PANE" : "TMUX_PANE");
}

function active(): typeof tmux {
  return getActiveMux().active === "wezterm" ? (wezterm as unknown as typeof tmux) : tmux;
}

export function createSurface(name: string): string {
  return active().createSurface(name);
}

export function createSurfaceSplit(
  name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
): string {
  return active().createSurfaceSplit(name, direction, fromSurface);
}

export function sendCommand(surface: string, command: string): void {
  active().sendCommand(surface, command);
}

export function sendLongCommand(
  surface: string,
  command: string,
  options?: { scriptPath?: string; scriptPreamble?: string },
): string {
  return active().sendLongCommand(surface, command, options);
}

export async function pollForExit(
  surface: string,
  signal: AbortSignal,
  options: {
    interval: number;
    sessionFile?: string;
    sentinelFile?: string;
    onTick?: (elapsed: number) => void;
  },
): Promise<import("./tmux.ts").PollResult> {
  return active().pollForExit(surface, signal, options);
}

export function closeSurface(surface: string): void {
  active().closeSurface(surface);
}

export function readScreen(surface: string, lines?: number): string {
  return active().readScreen(surface, lines);
}

export async function readScreenAsync(surface: string, lines?: number): Promise<string> {
  return active().readScreenAsync(surface, lines);
}