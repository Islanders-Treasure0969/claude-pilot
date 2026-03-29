/**
 * cmux Worker — Runs in a separate process from Express.
 *
 * Maintains a PERSISTENT connection to cmux's Unix socket.
 * Parent (Express) communicates via stdin/stdout (JSON lines).
 *
 * Architecture:
 *   Express ←→ stdin/stdout ←→ cmux-worker.js ←→ persistent socket ←→ cmux daemon
 *
 * Protocol (stdin → worker):
 *   {"id": 1, "action": "send", "surface_id": "UUID", "text": "hello\n"}
 *   {"id": 2, "action": "ping"}
 *   {"id": 3, "action": "list", "workspace_id": "UUID"}
 *   {"id": 4, "action": "raw", "method": "...", "params": {...}}
 *
 * Protocol (worker → stdout):
 *   {"id": 1, "ok": true, "result": {}}
 *   {"id": 2, "ok": false, "error": "Connection refused"}
 */

import net from "net";
import { createInterface } from "readline";

const SOCKET_PATH = process.env.CMUX_SOCKET_PATH ||
  `${process.env.HOME}/Library/Application Support/cmux/cmux.sock`;
const RECONNECT_DELAY = 2000;
const CALL_TIMEOUT = 5000;

// ── Persistent socket connection ─────────────────

let sock = null;
let responseBuf = "";
let currentResolve = null;
let currentReject = null;
let currentTimer = null;
let callQueue = []; // Queue for serialized access
let processing = false;

function connect() {
  return new Promise((resolve, reject) => {
    sock = net.createConnection(SOCKET_PATH);
    sock.on("connect", () => {
      responseBuf = "";
      resolve();
    });
    sock.on("data", onData);
    sock.on("error", (err) => {
      if (currentReject) {
        clearTimeout(currentTimer);
        currentReject(err);
        currentResolve = null;
        currentReject = null;
        currentTimer = null;
      }
      sock = null;
      reject(err);
    });
    sock.on("close", () => {
      sock = null;
      // Auto-reconnect
      setTimeout(() => {
        connect().catch(() => {});
      }, RECONNECT_DELAY);
    });
  });
}

function onData(chunk) {
  responseBuf += chunk.toString();
  // Try to parse complete JSON responses (one per line)
  const lines = responseBuf.split("\n");
  responseBuf = lines.pop(); // Keep incomplete last line

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (currentResolve) {
        clearTimeout(currentTimer);
        const resolve = currentResolve;
        currentResolve = null;
        currentReject = null;
        currentTimer = null;
        resolve(parsed);
      }
    } catch {
      // Not valid JSON, accumulate with next chunk
      responseBuf = line + "\n" + responseBuf;
    }
  }

  // Also try parsing the full buffer (response might not end with newline)
  if (currentResolve && responseBuf.trim()) {
    try {
      const parsed = JSON.parse(responseBuf);
      responseBuf = "";
      clearTimeout(currentTimer);
      const resolve = currentResolve;
      currentResolve = null;
      currentReject = null;
      currentTimer = null;
      resolve(parsed);
    } catch {
      // Incomplete, wait for more data
    }
  }
}

async function socketCall(method, params) {
  // Ensure connected
  if (!sock || sock.destroyed) {
    await connect();
  }

  return new Promise((resolve, reject) => {
    currentTimer = setTimeout(() => {
      currentResolve = null;
      currentReject = null;
      currentTimer = null;
      reject(new Error(`Timeout: ${method}`));
    }, CALL_TIMEOUT);

    currentResolve = (parsed) => {
      if (parsed.ok) resolve(parsed.result || {});
      else reject(new Error(parsed.error?.message || parsed.error || `${method} failed`));
    };
    currentReject = reject;

    sock.write(JSON.stringify({ method, params }) + "\n");
  });
}

// Serialize calls to avoid interleaving responses
async function serializedCall(method, params) {
  return new Promise((resolve, reject) => {
    callQueue.push({ method, params, resolve, reject });
    processQueue();
  });
}

async function processQueue() {
  if (processing || callQueue.length === 0) return;
  processing = true;
  const { method, params, resolve, reject } = callQueue.shift();
  try {
    const result = await socketCall(method, params);
    resolve(result);
  } catch (e) {
    reject(e);
  }
  processing = false;
  processQueue(); // Process next in queue
}

// ── Action dispatch ──────────────────────────────

async function handleMessage(msg) {
  switch (msg.action) {
    case "send":
      return await serializedCall("surface.send_text", {
        surface_id: msg.surface_id,
        text: msg.text,
      });

    case "ping":
      return await serializedCall("system.ping", {});

    case "list":
      return await serializedCall("surface.list", {
        workspace: msg.workspace_id,
      });

    case "raw":
      return await serializedCall(msg.method, msg.params || {});

    default:
      throw new Error(`Unknown action: ${msg.action}`);
  }
}

// ── stdin/stdout protocol ────────────────────────

function respond(id, ok, data) {
  const msg = ok
    ? JSON.stringify({ id, ok: true, result: data })
    : JSON.stringify({ id, ok: false, error: String(data) });
  process.stdout.write(msg + "\n");
}

const rl = createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  try {
    const result = await handleMessage(msg);
    respond(msg.id, true, result);
  } catch (e) {
    respond(msg.id, false, e.message);
  }
});

// ── Startup ──────────────────────────────────────

try {
  await connect();
  process.stderr.write(`[cmux-worker] ready — pid=${process.pid}, persistent connection\n`);
} catch (e) {
  process.stderr.write(`[cmux-worker] failed to connect: ${e.message}\n`);
  process.exit(1);
}
