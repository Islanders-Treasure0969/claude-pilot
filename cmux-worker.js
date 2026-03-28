#!/usr/bin/env node
/**
 * cmux Worker Process — Standalone long-running process for cmux socket communication.
 *
 * Problem: When an Express server communicates with cmux via Unix socket directly,
 * the connection becomes unstable after minutes (likely due to event loop contention,
 * timer interference, or Express's keep-alive management affecting net.Socket).
 *
 * Solution: This worker runs as a SEPARATE process with its own event loop.
 * The parent (Express) communicates with it via stdin/stdout (JSON lines),
 * and the worker handles all cmux socket calls independently.
 *
 * Protocol (stdin → worker):
 *   {"id": 1, "action": "send", "surface_id": "UUID", "text": "hello\n"}
 *   {"id": 2, "action": "ping"}
 *   {"id": 3, "action": "list", "workspace_id": "UUID"}
 *
 * Protocol (worker → stdout):
 *   {"id": 1, "ok": true, "result": {}}
 *   {"id": 2, "ok": false, "error": "Connection refused"}
 */

import net from "net";
import { createInterface } from "readline";

const SOCKET_PATH = process.env.CMUX_SOCKET_PATH ||
  `${process.env.HOME}/Library/Application Support/cmux/cmux.sock`;
const SOCKET_TIMEOUT = 5000;

// ── Socket call (same pattern as cmux-bridge.js) ────────────────────

function socketCall(method, params) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(SOCKET_PATH);
    let responseData = "";
    let settled = false;

    const settle = (fn, val) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        sock.destroy();
        fn(val);
      }
    };

    const timer = setTimeout(
      () => settle(reject, new Error(`Timeout: ${method}`)),
      SOCKET_TIMEOUT
    );

    sock.on("connect", () => {
      sock.write(JSON.stringify({ method, params }) + "\n");
    });

    sock.on("data", (chunk) => {
      responseData += chunk.toString();
      try {
        const parsed = JSON.parse(responseData);
        if (parsed.ok) settle(resolve, parsed.result || {});
        else settle(reject, new Error(parsed.error?.message || parsed.error || `${method} failed`));
      } catch {
        // incomplete JSON, wait for more data
      }
    });

    sock.on("error", (err) => settle(reject, err));
    sock.on("close", () => {
      if (!settled) settle(reject, new Error(`Connection closed: ${method}`));
    });
  });
}

// ── Action handlers ─────────────────────────────────────────────────

async function handleAction(msg) {
  switch (msg.action) {
    case "send":
      return await socketCall("surface.send_text", {
        surface_id: msg.surface_id,
        text: msg.text,
      });

    case "ping":
      return await socketCall("system.ping", {});

    case "list":
      return await socketCall("surface.list", {
        workspace: msg.workspace_id,
      });

    case "raw":
      // Generic socket call: {action: "raw", method: "...", params: {...}}
      return await socketCall(msg.method, msg.params || {});

    default:
      throw new Error(`Unknown action: ${msg.action}`);
  }
}

// ── Main loop: read JSON lines from stdin ───────────────────────────

function respond(id, ok, data) {
  const line = ok
    ? JSON.stringify({ id, ok: true, result: data })
    : JSON.stringify({ id, ok: false, error: String(data) });
  process.stdout.write(line + "\n");
}

const rl = createInterface({ input: process.stdin });

rl.on("line", async (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    respond(null, false, "Invalid JSON");
    return;
  }

  const id = msg.id ?? null;

  try {
    const result = await handleAction(msg);
    respond(id, true, result);
  } catch (err) {
    respond(id, false, err.message);
  }
});

rl.on("close", () => {
  process.exit(0);
});

// Keep the process alive
process.stdin.resume();

// Signal readiness
process.stderr.write("[cmux-worker] ready — pid=" + process.pid + "\n");
