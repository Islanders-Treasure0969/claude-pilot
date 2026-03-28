/**
 * cmux Bridge — Communicates with cmux via a separate worker process.
 *
 * Architecture:
 *   Express Server ←→ stdin/stdout (JSON lines) ←→ cmux-worker.js ←→ cmux socket
 *
 * Why a worker process?
 *   Direct socket communication from the Express process becomes unstable
 *   when cmux browser panes are also connected (cmux Issue #952).
 *   A separate worker process has its own event loop and maintains a
 *   stable connection to the cmux socket regardless of Express activity.
 */

import path from "path";
import { fileURLToPath } from "url";
import { fork } from "child_process";
import { createInterface } from "readline";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class CmuxBridge {
  constructor() {
    this.workspaceId = process.env.CMUX_WORKSPACE_ID || null;
    this.surfaceId = process.env.CMUX_SURFACE_ID || null;
    this.claudePid = process.env.CMUX_CLAUDE_PID || null;
    this.available = !!this.workspaceId;
    this.claudeSurfaces = [];

    this._worker = null;
    this._msgId = 0;
    this._pending = new Map(); // id → { resolve, reject, timer }
    this._rl = null;

    this.ready = this.available ? this._init().catch(() => { this.available = false; }) : Promise.resolve();
  }

  // ── Worker lifecycle ──────────────────────────────

  async _init() {
    this._spawnWorker();
    try {
      await this._call("ping");
    } catch {
      this.available = false;
      return;
    }
    await this.refreshClaudeSurfaces();
  }

  _spawnWorker() {
    const workerPath = path.join(__dirname, "cmux-worker.js");
    this._worker = fork(workerPath, [], {
      stdio: ["pipe", "pipe", "inherit", "ipc"],
      env: { ...process.env },
    });

    this._rl = createInterface({ input: this._worker.stdout });
    this._rl.on("line", (line) => {
      try {
        const msg = JSON.parse(line);
        const pending = this._pending.get(msg.id);
        if (pending) {
          this._pending.delete(msg.id);
          clearTimeout(pending.timer);
          if (msg.ok) pending.resolve(msg.result);
          else pending.reject(new Error(msg.error || "Worker call failed"));
        }
      } catch {}
    });

    this._worker.on("exit", (code) => {
      console.error(`  cmux: worker exited (code ${code}), restarting...`);
      // Reject all pending calls
      for (const [id, p] of this._pending) {
        clearTimeout(p.timer);
        p.reject(new Error("Worker exited"));
      }
      this._pending.clear();
      // Auto-restart after 1 second
      if (this.available) {
        setTimeout(() => this._spawnWorker(), 1000);
      }
    });
  }

  _call(action, params = {}, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      if (!this._worker || !this._worker.connected) {
        return reject(new Error("Worker not available"));
      }
      const id = ++this._msgId;
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`Timeout: ${action}`));
      }, timeoutMs);

      this._pending.set(id, { resolve, reject, timer });
      const msg = JSON.stringify({ id, action, ...params });
      this._worker.stdin.write(msg + "\n");
    });
  }

  // ── Claude Code Surface Discovery ──────────────

  async refreshClaudeSurfaces() {
    if (!this.available) return [];
    try {
      const result = await this._call("list", { workspace_id: this.workspaceId });
      const terminals = (result.surfaces || []).filter(s => s.type === "terminal");
      const claudeMatches = [];
      const hereMatches = [];

      for (const s of terminals) {
        const entry = { id: s.id, ref: s.ref, title: s.title || "" };
        // Priority 1: title contains "Claude"
        if (/\bclaude\s*(code|>|\|)/i.test(s.title || "") || /^claude\b/i.test(s.title || "")) {
          claudeMatches.push(entry);
        }
        // Priority 2: the surface where THIS Claude Code session runs
        // It's typically selected_in_pane=true (visible tab), could be focused or not
        // Exclude known non-Claude surfaces by title
        if (s.selected_in_pane && !/^Yazi:|^vim:|^nvim:|data_platform/i.test(s.title || "")) {
          hereMatches.push(entry);
        }
      }

      if (claudeMatches.length > 0) this.claudeSurfaces = claudeMatches;
      else if (hereMatches.length > 0) this.claudeSurfaces = hereMatches;
      else {
        this.claudeSurfaces = terminals
          .filter(s => !/^Yazi:|^vim:|^nvim:/i.test(s.title || ""))
          .map(s => ({ id: s.id, ref: s.ref, title: s.title || "" }));
      }
      return this.claudeSurfaces;
    } catch (e) {
      console.error(`  cmux: refreshClaudeSurfaces failed — ${e.message}`);
      return this.claudeSurfaces;
    }
  }

  getDefaultClaudeSurface() {
    // CMUX_SURFACE_ID is a UUID that directly identifies the Claude Code terminal
    if (this.surfaceId) return this.surfaceId;
    if (this.claudeSurfaces.length === 1) return this.claudeSurfaces[0].id;
    return this.claudeSurfaces[0]?.id || null;
  }

  // ── Send to Terminal ───────────────────────────

  async sendToClaudeCode(text) {
    const target = this.getDefaultClaudeSurface();
    if (!target) return false;
    try {
      await this._call("send", { surface_id: target, text: text + "\n" });
      return true;
    } catch (e) {
      console.error(`  cmux: sendToClaudeCode failed — ${e.message}`);
      return false;
    }
  }

  // ── Sidebar Status (via worker) ──────────��─────

  async setStatus(key, value, opts = {}) {
    if (!this.available) return;
    try {
      await this._call("raw", {
        method: "notification.create",
        params: { workspace: this.workspaceId, title: `${key}: ${value}` },
      });
    } catch {}
  }

  async clearStatus(key) { /* no-op for now */ }
  async setProgress(value, label) { /* no-op for now */ }
  async clearProgress() { /* no-op for now */ }

  // ── Logging & Notifications ────────────────────

  async log(level, source, message) {
    if (!this.available) return;
    try {
      await this._call("raw", {
        method: "notification.create",
        params: { workspace: this.workspaceId, title: `[${source}] ${message}` },
      });
    } catch {}
  }

  async notify(title, body) {
    if (!this.available) return;
    try {
      await this._call("raw", {
        method: "notification.create",
        params: { workspace: this.workspaceId, title, body: body || "" },
      });
    } catch {}
  }

  // ── Browser Pane ───────────────────────────────

  async openBrowserPane(url) {
    if (!this.available) return false;
    try {
      await this._call("raw", {
        method: "pane.create",
        params: { workspace: this.workspaceId, type: "browser", url },
      });
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

  // ── Cleanup ────────────────────────────────────

  destroy() {
    if (this._worker) {
      this._worker.kill();
      this._worker = null;
    }
    if (this._rl) {
      this._rl.close();
      this._rl = null;
    }
  }
}
