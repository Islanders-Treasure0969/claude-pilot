/**
 * cmux Bridge — Encapsulates all cmux CLI interactions for Claude Pilot.
 * Falls back gracefully when cmux is not available.
 *
 * Handles cmux socket instability (Issue #952) via:
 * - Periodic ping heartbeat to detect disconnection early
 * - Socket path re-discovery on failure
 * - Exponential backoff retry on exec failures
 * - Concurrency limiting (max 3 simultaneous execFile calls)
 */

import { execFile } from "child_process";
import fs from "fs";
import path from "path";

const EXEC_TIMEOUT = 5000;
const CMUX_BIN = process.env.CMUX_BIN || "/Applications/cmux.app/Contents/Resources/bin/cmux";
const HEARTBEAT_INTERVAL = 30000; // 30s
const MAX_CONCURRENT = 3;
const SOCKET_ERRORS = /ECONNREFUSED|ENOENT|ETIMEDOUT|socket|connect/i;

export class CmuxBridge {
  constructor() {
    this.workspaceId = process.env.CMUX_WORKSPACE_ID || null;
    this.surfaceId = process.env.CMUX_SURFACE_ID || null;
    this.claudePid = process.env.CMUX_CLAUDE_PID || null;
    this.socketPath = process.env.CMUX_SOCKET_PATH || null;
    this.available = !!this.workspaceId;
    this.claudeSurfaces = [];
    this._concurrency = 0;
    this._queue = [];

    this.ready = this.available ? this._init().catch(() => { this.available = false; }) : Promise.resolve();
  }

  async _init() {
    try {
      await this._rawExec(["ping"]);
    } catch {
      this.available = false;
      return;
    }
    await this.refreshClaudeSurfaces();
    this._startHeartbeat();
  }

  // ── Heartbeat: periodic ping to detect disconnection ──

  _startHeartbeat() {
    this._heartbeatTimer = setInterval(async () => {
      if (!this.workspaceId) return;
      try {
        await this._rawExec(["ping"]);
        if (!this.available) {
          this.available = true;
          await this.refreshClaudeSurfaces();
          console.log("  cmux: connection recovered");
        }
      } catch {
        // Always try to re-discover, regardless of current available state
        const recovered = await this._rediscoverSocket();
        if (!recovered && this.available) {
          console.warn("  cmux: heartbeat failed, marking unavailable");
          this.available = false;
        }
      }
    }, HEARTBEAT_INTERVAL);
    this._heartbeatTimer.unref();
  }

  stopHeartbeat() {
    if (this._heartbeatTimer) clearInterval(this._heartbeatTimer);
  }

  // ── Socket path re-discovery ──────────────────────

  async _rediscoverSocket() {
    // Try last-socket-path file (cmux writes this)
    try {
      const lastPathFile = path.join(
        process.env.HOME || "", "Library", "Application Support", "cmux", "last-socket-path"
      );
      const newPath = fs.readFileSync(lastPathFile, "utf-8").trim();
      if (newPath && newPath !== this.socketPath) {
        this.socketPath = newPath;
        await this._rawExec(["ping"]);
        this.available = true;
        await this.refreshClaudeSurfaces();
        console.log(`  cmux: recovered via new socket path`);
        return true;
      }
    } catch {}

    // Try without socket path (let cmux auto-detect)
    try {
      const saved = this.socketPath;
      this.socketPath = null;
      await this._rawExec(["ping"]);
      this.available = true;
      await this.refreshClaudeSurfaces();
      console.log("  cmux: recovered without explicit socket path");
      return true;
    } catch {
      return false;
    }
  }

  // ── Concurrency-limited exec ──────────────────────

  async _acquireSemaphore() {
    if (this._concurrency < MAX_CONCURRENT) { this._concurrency++; return; }
    await new Promise(resolve => this._queue.push(resolve));
  }

  _releaseSemaphore() {
    this._concurrency--;
    if (this._queue.length > 0) { this._concurrency++; this._queue.shift()(); }
  }

  // Raw exec without retry or concurrency control (for internal use)
  _rawExec(args) {
    const fullArgs = this.socketPath ? ["--socket", this.socketPath, ...args] : args;
    return new Promise((resolve, reject) => {
      const child = execFile(CMUX_BIN, fullArgs, { timeout: EXEC_TIMEOUT }, (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout.trim());
      });
      child.on("error", () => {}); // Prevent unhandled error
      child.stdin?.end();
    });
  }

  // Public exec with concurrency control and retry
  async exec(args) {
    await this._acquireSemaphore();
    try {
      return await this._rawExec(args);
    } catch (err) {
      // Retry once with socket re-discovery if it's a connection error
      if (SOCKET_ERRORS.test(err.message)) {
        const recovered = await this._rediscoverSocket();
        if (recovered) {
          try { return await this._rawExec(args); } catch { throw err; }
        }
      }
      throw err;
    } finally {
      this._releaseSemaphore();
    }
  }

  // ── Claude Code Surface Discovery ──────────────

  async refreshClaudeSurfaces() {
    if (!this.available) return [];
    try {
      const tree = await this.exec(["tree", "--workspace", this.workspaceId]);
      const allTerminals = [];
      const claudeMatches = [];
      const hereMatches = [];

      for (const line of tree.split("\n")) {
        const termMatch = line.match(/(surface:\d+)\s+\[terminal\]\s+"([^"]*)"/);
        if (!termMatch) continue;
        const ref = termMatch[1];
        const title = termMatch[2];
        allTerminals.push({ ref, title });

        if (/\bclaude\s*(code|>|\|)/i.test(title) || /^claude\b/i.test(title)) claudeMatches.push({ ref, title });
        if (/here/.test(line)) hereMatches.push({ ref, title });
      }

      if (claudeMatches.length > 0) this.claudeSurfaces = claudeMatches;
      else if (hereMatches.length > 0) this.claudeSurfaces = hereMatches;
      else this.claudeSurfaces = allTerminals.filter(s => !/^Yazi:|^vim:|^nvim:/i.test(s.title));

      return this.claudeSurfaces;
    } catch {
      return this.claudeSurfaces;
    }
  }

  getDefaultClaudeSurface() {
    if (this.claudeSurfaces.length === 1) return this.claudeSurfaces[0].ref;
    const envSurface = this.claudeSurfaces.find(s => s.ref === `surface:${this.surfaceId}`);
    if (envSurface) return envSurface.ref;
    return this.claudeSurfaces[0]?.ref || null;
  }

  // ── Send to Terminal ───────────────────────────

  async sendToSurface(surfaceRef, text) {
    if (!this.available || !surfaceRef) return false;
    try {
      await this.exec(["send", "--surface", surfaceRef, text]);
      return true;
    } catch { return false; }
  }

  async sendKey(surfaceRef, key) {
    if (!this.available || !surfaceRef) return false;
    try {
      await this.exec(["send-key", "--surface", surfaceRef, key]);
      return true;
    } catch { return false; }
  }

  async sendToClaudeCode(text, surfaceRef) {
    // Always refresh before sending to get latest surface state
    await this.refreshClaudeSurfaces();
    let target = surfaceRef || this.getDefaultClaudeSurface();

    if (!target || !(await this.sendToSurface(target, text))) {
      // Retry with fresh surfaces
      await this.refreshClaudeSurfaces();
      target = this.getDefaultClaudeSurface();
      if (!target) { console.error("  cmux: No Claude Code surface found."); return false; }
      const sent = await this.sendToSurface(target, text);
      if (!sent) { console.error(`  cmux: Failed to send to ${target} after retry.`); return false; }
    }
    return this.sendKey(target, "enter");
  }

  // ── Sidebar Status ─────────────────────────────

  async setStatus(key, value, opts = {}) {
    if (!this.available) return;
    const args = ["set-status", key, value, "--workspace", this.workspaceId];
    if (opts.icon) args.push("--icon", opts.icon);
    if (opts.color) args.push("--color", opts.color);
    try { await this.exec(args); } catch {}
  }

  async clearStatus(key) {
    if (!this.available) return;
    try { await this.exec(["clear-status", key, "--workspace", this.workspaceId]); } catch {}
  }

  async setProgress(value, label) {
    if (!this.available) return;
    const args = ["set-progress", String(value), "--workspace", this.workspaceId];
    if (label) args.push("--label", label);
    try { await this.exec(args); } catch {}
  }

  async clearProgress() {
    if (!this.available) return;
    try { await this.exec(["clear-progress", "--workspace", this.workspaceId]); } catch {}
  }

  // ── Logging & Notifications ────────────────────

  async log(level, source, message) {
    if (!this.available) return;
    try { await this.exec(["log", "--level", level, "--source", source, "--workspace", this.workspaceId, "--", message]); } catch {}
  }

  async notify(title, body, subtitle) {
    if (!this.available) return;
    const args = ["notify", "--title", title, "--workspace", this.workspaceId];
    if (subtitle) args.push("--subtitle", subtitle);
    if (body) args.push("--body", body);
    try { await this.exec(args); } catch {}
  }

  // ── Browser Pane ───────────────────────────────

  async openBrowserPane(url) {
    if (!this.available) return false;
    try {
      const tree = await this.exec(["tree", "--workspace", this.workspaceId]);
      if (tree.includes(url)) return false;
      await this.exec(["new-pane", "--type", "browser", "--workspace", this.workspaceId, "--url", url]);
      return true;
    } catch { return false; }
  }

  // ── Context ────────────────────────────────────

  getContext() {
    return {
      available: this.available,
      workspaceId: this.workspaceId,
      claudePid: this.claudePid,
      claudeSurfaces: this.claudeSurfaces,
      defaultSurface: this.getDefaultClaudeSurface(),
    };
  }
}
