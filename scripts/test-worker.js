#!/usr/bin/env node
/**
 * Test script for cmux-worker.js
 *
 * Spawns the worker as a child process, sends commands via stdin,
 * reads results from stdout, and verifies the worker approach works.
 *
 * Usage:
 *   node scripts/test-worker.js
 *   node scripts/test-worker.js --surface <UUID>
 *   node scripts/test-worker.js --ping-only
 */

import { spawn } from "child_process";
import { createInterface } from "readline";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const WORKER_PATH = join(__dirname, "..", "cmux-worker.js");

// Default test surface (Claude Code terminal)
const DEFAULT_SURFACE = "6E13D065-125D-45C9-A56D-671F41CC246A";

// ── Parse args ──────────────────────────────────────────────────────

const args = process.argv.slice(2);
const pingOnly = args.includes("--ping-only");
const surfaceIdx = args.indexOf("--surface");
const surfaceId = surfaceIdx !== -1 ? args[surfaceIdx + 1] : DEFAULT_SURFACE;

// ── Spawn worker ────────────────────────────────────────────────────

console.log("=== cmux Worker PoC Test ===\n");
console.log(`Worker script: ${WORKER_PATH}`);
console.log(`Target surface: ${surfaceId}`);
console.log(`Mode: ${pingOnly ? "ping only" : "ping + send"}\n`);

const worker = spawn("node", [WORKER_PATH], {
  stdio: ["pipe", "pipe", "pipe"],
});

// Capture stderr (worker readiness + diagnostics)
worker.stderr.on("data", (data) => {
  console.log(`[worker stderr] ${data.toString().trim()}`);
});

worker.on("error", (err) => {
  console.error(`Failed to spawn worker: ${err.message}`);
  process.exit(1);
});

worker.on("exit", (code) => {
  console.log(`\n[worker] exited with code ${code}`);
});

// ── Communication helpers ───────────────────────────────────────────

const rl = createInterface({ input: worker.stdout });
const pending = new Map(); // id → { resolve, reject, timer }
let nextId = 1;

rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    console.error(`[worker stdout] non-JSON: ${line}`);
    return;
  }

  const entry = pending.get(msg.id);
  if (entry) {
    clearTimeout(entry.timer);
    pending.delete(msg.id);
    entry.resolve(msg);
  } else {
    console.log(`[worker stdout] unmatched response:`, msg);
  }
});

function sendCommand(cmd, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const message = { id, ...cmd };

    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Command timed out after ${timeoutMs}ms: ${JSON.stringify(cmd)}`));
    }, timeoutMs);

    pending.set(id, { resolve, reject, timer });
    worker.stdin.write(JSON.stringify(message) + "\n");
  });
}

// ── Run tests ───────────────────────────────────────────────────────

async function runTests() {
  // Give worker a moment to initialize
  await new Promise((r) => setTimeout(r, 500));

  let passed = 0;
  let failed = 0;

  // Test 1: Ping
  console.log("--- Test 1: ping ---");
  try {
    const result = await sendCommand({ action: "ping" });
    if (result.ok) {
      console.log(`  PASS: ping succeeded`, result.result);
      passed++;
    } else {
      console.log(`  FAIL: ping returned error:`, result.error);
      failed++;
    }
  } catch (err) {
    console.log(`  FAIL: ${err.message}`);
    failed++;
  }

  if (!pingOnly) {
    // Test 2: Send text to terminal
    console.log("\n--- Test 2: send_text ---");
    try {
      const result = await sendCommand({
        action: "send",
        surface_id: surfaceId,
        text: "echo worker test\n",
      });
      if (result.ok) {
        console.log(`  PASS: send_text succeeded`, result.result);
        passed++;
      } else {
        console.log(`  FAIL: send_text returned error:`, result.error);
        failed++;
      }
    } catch (err) {
      console.log(`  FAIL: ${err.message}`);
      failed++;
    }

    // Test 3: Rapid-fire sends (stability check)
    console.log("\n--- Test 3: rapid-fire 5 sends ---");
    try {
      const promises = [];
      for (let i = 0; i < 5; i++) {
        promises.push(
          sendCommand({
            action: "send",
            surface_id: surfaceId,
            text: `# worker burst ${i + 1}/5\n`,
          })
        );
      }
      const results = await Promise.all(promises);
      const allOk = results.every((r) => r.ok);
      if (allOk) {
        console.log(`  PASS: all 5 rapid sends succeeded`);
        passed++;
      } else {
        const failures = results.filter((r) => !r.ok);
        console.log(`  FAIL: ${failures.length}/5 sends failed`);
        failed++;
      }
    } catch (err) {
      console.log(`  FAIL: ${err.message}`);
      failed++;
    }
  }

  // Summary
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);

  // Clean shutdown
  worker.stdin.end();

  // Force exit after grace period
  setTimeout(() => process.exit(failed > 0 ? 1 : 0), 1000);
}

runTests().catch((err) => {
  console.error("Test runner error:", err);
  worker.kill();
  process.exit(1);
});
