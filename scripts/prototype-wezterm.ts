/**
 * PROTOTYPE driver — exercises every primitive in
 * `pi-extension/subagents/wezterm.ts.PROTOTYPE` against a live WezTerm
 * mux server and prints the full state after every action (per the
 * prototype-skill "Surface the state" rule).
 *
 * Run inside WezTerm on Windows:
 *   node --import tsx scripts/prototype-wezterm.ts
 * (or `npx tsx scripts/prototype-wezterm.ts` if tsx is on the path).
 *
 * Throwaway — does not touch git-tracked files. Clean up the prototype
 * file and this driver after the verdict is captured on Issue #3.
 */
import {
  _weztermAvailability,
  isMuxAvailable,
  createSurface,
  createSurfaceSplit,
  sendCommand,
  sendLongCommand,
  readScreen,
  readScreenAsync,
  closeSurface,
  muxSetupHint,
} from "../pi-extension/subagents/wezterm.prototype-shim.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function showState(label: string, state: unknown): void {
  console.log(`\n── ${label} ──`);
  console.log(typeof state === "string" ? state : JSON.stringify(state, null, 2));
}

async function main() {
  showState("availability (_weztermAvailability)", _weztermAvailability());
  showState("isMuxAvailable", { result: isMuxAvailable() });
  if (!isMuxAvailable()) {
    console.log(`\nmux not available: ${muxSetupHint()}`);
    return;
  }

  const opened: string[] = [];
  const cleanup = () => {
    for (const id of opened) {
      try {
        closeSurface(id);
      } catch {}
    }
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(1);
  });

  // 1. createSurface — right split off $WEZTERM_PANE
  const right = createSurface("echo-test-right");
  opened.push(right);
  showState("createSurface (right)", { surface: right });

  await sleep(800);
  const marker1 = `WEZTERM_PROTO_${Date.now()}`;
  sendCommand(right, `echo ${marker1}`);
  await sleep(1500);
  const screen1 = readScreen(right, 30);
  showState("screen after sendCommand", { surface: right, contains: screen1.includes(marker1), screen: screen1 });

  // 2. sendLongCommand — pwsh .ps1 launcher with sentinel
  const marker2 = `WEZTERM_LONGCMD_${Date.now()}`;
  sendLongCommand(right, `Write-Output "${marker2}"`, { scriptPreamble: `# prototype preamble` });
  await sleep(2500);
  const screen2 = readScreen(right, 30);
  showState("screen after sendLongCommand", {
    surface: right,
    containsMarker: screen2.includes(marker2),
    containsSentinel: /__SUBAGENT_DONE_\d+__/.test(screen2),
    screen: screen2,
  });

  // 3. createSurfaceSplit — every direction, off a known source
  const directions = ["left", "up", "down"] as const;
  for (const d of directions) {
    const id = createSurfaceSplit(`split-${d}`, d, right);
    opened.push(id);
    showState(`createSurfaceSplit ${d}`, { surface: id });
    await sleep(400);
    try {
      closeSurface(id);
      opened.pop();
      showState(`closeSurface (split-${d})`, { surface: id, ok: true });
    } catch (err: any) {
      showState(`closeSurface (split-${d}) FAILED`, { surface: id, error: err.message });
    }
  }

  // 4. readScreenAsync
  const screenAsync = await readScreenAsync(right, 10);
  showState("readScreenAsync", { surface: right, length: screenAsync.length, screen: screenAsync });

  // 5. closeSurface the original
  closeSurface(right);
  opened.pop();
  showState("closeSurface (right)", { surface: right, ok: true });

  console.log("\n✓ prototype driver completed. Review the state prints above.");
}

main().catch((err) => {
  console.error("PROTOTYPE FAILED:", err);
  process.exit(1);
});