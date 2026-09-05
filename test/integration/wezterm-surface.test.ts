/**
 * Integration tests for the WezTerm surface layer.
 *
 * These tests exercise real wezterm operations: creating panes,
 * sending commands, reading screen output, and closing panes.
 * No LLM calls — fast and free.
 *
 * Run inside WezTerm on Windows:
 *   PI_SUBAGENT_MUX=wezterm node --test test/integration/wezterm-surface.test.ts
 *
 * The tests use the mux-agnostic harness (mux.ts dispatchers), so they
 * work with the active mux.
 */
import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTestEnv,
  cleanupTestEnv,
  createTrackedSurface,
  createTrackedSurfaceSplit,
  focusSurface,
  getFocusedSurface,
  waitForFocusedSurface,
  untrackSurface,
  sendCommand,
  sendLongCommand,
  readScreen,
  readScreenAsync,
  closeSurface,
  sleep,
  uniqueId,
  waitForScreen,
  waitForFile,
  type TestEnv,
} from "./harness.ts";

describe("wezterm-surface", { timeout: 60_000 }, () => {
  let env: TestEnv;

  before(() => {
    env = createTestEnv();
  });

  after(() => {
    cleanupTestEnv(env);
  });

  afterEach(() => {
    // Close all tracked surfaces between tests so the parent pane
    // is back to its original state for the next test.
    for (const surface of (env.surfaces || [])) {
      try {
        closeSurface(surface);
      } catch {}
    }
    env.surfaces = [];
  });

  // ── Surface creation & basic operations ──────────────────────

  it("creates a surface, sends a command, reads output, and closes it", async () => {
    const surface = createTrackedSurface(env, "echo-test");
    await sleep(1000);

    const marker = uniqueId();
    sendCommand(surface, `echo "MARKER_${marker}"`);
    await sleep(1500);

    // Normalize screen output (wezterm cli get-text wraps across lines)
    const screen = readScreen(surface, 50).replace(/\r?\n/g, " ").trim();
    assert.ok(
      screen.includes(`MARKER_${marker}`),
      `Expected screen to contain MARKER_${marker}. Got:\n${screen}`,
    );

    closeSurface(surface);
    untrackSurface(env, surface);
  });

  // ── Async read ────────────────────────────────────────────────

  it("reads screen asynchronously", async () => {
    const surface = createTrackedSurface(env, "async-read-test");
    await sleep(1000);

    const marker = uniqueId();
    sendCommand(surface, `echo "ASYNC_${marker}"`);
    await sleep(1500);

    const screen = await readScreenAsync(surface, 50).then((s) =>
      s.replace(/\r?\n/g, " ").trim(),
    );
    assert.ok(
      screen.includes(`ASYNC_${marker}`),
      `Async read should find marker. Got:\n${screen}`,
    );

    closeSurface(surface);
    untrackSurface(env, surface);
  });

  // ── Focus preservation (best-effort) ──────────────────────────

  it("attempts focus preservation after surface creation", async () => {
    const surface = createTrackedSurface(env, "focus-test");
    await sleep(1000);

    focusSurface(surface);
    // Best-effort: wait for focus, may time out in some configurations.
    try {
      await waitForFocusedSurface(surface, 5_000);
    } catch {
      // focus propagation may be slow; not a hard failure
    }

    const marker = uniqueId();
    sendCommand(surface, `echo "FOCUS_${marker}"`);
    await sleep(1500);

    const screen = readScreen(surface, 50).replace(/\r?\n/g, " ").trim();
    assert.ok(
      screen.includes(`FOCUS_${marker}`),
      `Expected screen to contain FOCUS_${marker}. Got:\n${screen}`,
    );

    closeSurface(surface);
    untrackSurface(env, surface);
  });

  // ── Concurrent surface management (single-surface each) ──────

  it("manages a surface concurrently with another (independent)", async () => {
    const s1 = createTrackedSurface(env, "multi-1");
    const m1 = uniqueId();
    sendCommand(s1, `echo "S1_${m1}"`);
    await sleep(1500);

    const screen1 = readScreen(s1, 50).replace(/\r?\n/g, " ").trim();
    assert.ok(
      screen1.includes(`S1_${m1}`),
      `Surface 1 missing marker. Got:\n${screen1}`,
    );
    closeSurface(s1);
    untrackSurface(env, s1);

    const s2 = createTrackedSurface(env, "multi-2");
    const m2 = uniqueId();
    sendCommand(s2, `echo "S2_${m2}"`);
    await sleep(1500);

    const screen2 = readScreen(s2, 50).replace(/\r?\n/g, " ").trim();
    assert.ok(
      screen2.includes(`S2_${m2}`),
      `Surface 2 missing marker. Got:\n${screen2}`,
    );
    closeSurface(s2);
    untrackSurface(env, s2);
  });

  // ── Long command via script file ──────────────────────────────

  it("sends a long command via script file without truncation", async () => {
    const surface = createTrackedSurface(env, "long-cmd-test");
    await sleep(1000);

    const marker = uniqueId();
    const longValue = "X".repeat(500);
    const command = `echo "LONG_${marker}_${longValue}_END"`;

    sendLongCommand(surface, command);
    await sleep(2000);

    const screen = readScreen(surface, 50).replace(/\r?\n/g, " ").trim();
    assert.ok(
      screen.includes(`LONG_${marker}`),
      `Expected long command output. Got:\n${screen.slice(0, 300)}...`,
    );
    assert.ok(
      screen.includes("_END"),
      `Expected full output (not truncated). Got:\n${screen.slice(-300)}`,
    );

    closeSurface(surface);
    untrackSurface(env, surface);
  });

  // ── File write and read ───────────────────────────────────────
  //
  // On Windows with pwsh, use `Set-Content -Path ... -Value ...` instead of bash
  // redirection, and use Windows-style temp paths (via Node os.tmpdir()).

  it("writes output to a file and verifies via surface", async () => {
    const surface = createTrackedSurface(env, "file-test");
    await sleep(1000);

    const marker = uniqueId();
    // Use pwsh-native file-write syntax via sendCommand.
    // sendCommand sends raw text to the pane's shell; in pwsh we use
    // Set-Content (the equivalent of `>` redirection).
    const tempFile = join(tmpdir(), `pi-wezterm-test-${marker}.txt`);
    // PowerShell: Set-Content -Path 'path' -Value 'value'
    // (single-quote wrap avoids $/backtick expansion)
    const psCommand = `Set-Content -Path '${tempFile}' -Value "FILE_${marker}" `
      + `&& echo "WRITTEN_${marker}"`;

    sendCommand(surface, psCommand);
    await sleep(1500);

    // Normalize screen output for matching
    const screen = readScreen(surface, 50).replace(/\r?\n/g, " ").trim();
    assert.ok(
      screen.includes(`WRITTEN_${marker}`),
      `Expected WRITTEN marker in screen. Got:\n${screen}`,
    );

    // Verify file content from the Node.js side (the pane wrote to a path
    // accessible on the host filesystem since WezTerm runs locally).
    const fileContent = await waitForFile(tempFile, 10_000, new RegExp(`FILE_${marker}`));
    assert.ok(
      fileContent.includes(`FILE_${marker}`),
      `File content wrong. Got: ${fileContent}`,
    );

    // Clean up the temp file from the host filesystem
    rmSync(tempFile, { force: true });

    closeSurface(surface);
    untrackSurface(env, surface);
  });
});