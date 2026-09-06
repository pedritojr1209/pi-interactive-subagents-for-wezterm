/**
 * Shared command-availability check for the tmux and wezterm modules.
 *
 * Memoizes per-command results for the lifetime of the module. Uses
 * `command -v` on POSIX/WSL (matching the tmux.ts baseline) and `where`
 * on Windows (since `command -v` requires a sh shell that can see system
 * binaries, which Git-Bash on Windows often can't without mount table tweaks).
 */
import { execFileSync } from "node:child_process";

const memo = new Map<string, boolean>();

export function hasCommand(command: string): boolean {
  const cached = memo.get(command);
  if (cached !== undefined) return cached;

  let available = false;
  if (process.platform === "win32") {
    try {
      execFileSync("where", [command], { stdio: "ignore" });
      available = true;
    } catch {
      available = false;
    }
  } else {
    try {
      execFileSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" });
      available = true;
    } catch {
      available = false;
    }
  }

  memo.set(command, available);
  return available;
}