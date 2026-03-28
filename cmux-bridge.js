/**
 * cmux Bridge — Communicates with cmux via direct Unix socket connection.
 *
 * Uses Node.js net module instead of execFile("cmux") CLI to avoid
 * socket contention with cmux browser panes (cmux Issue #952).
 * The CLI approach spawns child processes that compete with the browser
 * for the cmux socket's accept queue. Direct socket communication
 * shares the connection cleanly.
 */

import net from "net";
import { execFile } from "child_process";

const SOCKET_TIMEOUT = 5000;
const CMUX_BIN = process.env.CMUX_BIN || "/Applications/cmux.app/Contents/Resources/bin/cmux";

export class CmuxBridge {
  constructor() {
    this.workspaceId = process.env.CMUX_WORKSPACE_ID || null;
    this.surfaceId = process.env.CMUX_SURFACE_ID || null;
    this.claudePid = process.env.CMUX_CLAUDE_PID || null;
    this.socketPath = process.env.CMUX_SOCKET_PATH ||
      (process.env.HOME ? `${process.env.HOME}/Library/Application Support/cmux/cmux.sock` : null);
    this.available = !!this.workspaceId;
    this.claudeSurfaces = [];

    this.ready = this.available ? this._init().catch(() => { this.available = false; }) : Promise.resolve();
  }

  async _init() {
    try {
      await this.socketCall("system.ping", {});
    } catch {
      this.available = false;
      return;
    }
    await this.refreshClaudeSurfaces();
  }

  // ── Direct socket communication ─────────────────

  socketCall(method, params) {
    return new Promise((resolve, reject) => {
      if (!this.socketPath) return reject(new Error("No socket path"));

      const sock = net.createConnection(this.socketPath);
      let responseData = "";
      let settled = false;

      const settle = (fn, val) => { if (!settled) { settled = true; clearTimeout(timer); sock.destroy(); fn(val); } };
      const timer = setTimeout(() => settle(reject, new Error(`Timeout: ${method}`)), SOCKET_TIMEOUT);

      sock.on("connect", () => sock.write(JSON.stringify({ method, params }) + "\n"));

      sock.on("data", (chunk) => {
        responseData += chunk.toString();
        try {
          const parsed = JSON.parse(responseData);
          if (parsed.ok) settle(resolve, parsed.result || {});
          else settle(reject, new Error(parsed.error?.message || parsed.error || `${method} failed`));
        } catch { /* incomplete JSON, wait for more */ }
      });

      sock.on("error", (err) => settle(reject, err));
      sock.on("close", () => { if (!settled) settle(reject, new Error(`Connection closed: ${method}`)); });
    });
  }

  // Legacy exec for commands not yet migrated to socket
  exec(args) {
    const fullArgs = this.socketPath ? ["--socket", this.socketPath, ...args] : args;
    return new Promise((resolve, reject) => {
      execFile(CMUX_BIN, fullArgs, { timeout: SOCKET_TIMEOUT }, (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout.trim());
      });
    });
  }

  // ── Claude Code Surface Discovery ──────────────

  async refreshClaudeSurfaces() {
    if (!this.available) return [];
    try {
      const result = await this.socketCall("surface.list", {
        workspace: this.workspaceId,
      });
      const terminals = (result.surfaces || []).filter(s => s.type === "terminal");
      const claudeMatches = [];
      const hereMatches = [];

      for (const s of terminals) {
        const entry = { id: s.id, ref: s.ref, title: s.title || "" };
        if (/\bclaude\s*(code|>|\|)/i.test(s.title || "") || /^claude\b/i.test(s.title || "")) {
          claudeMatches.push(entry);
        }
        // The surface where Claude Code (this session) is running
        if (s.selected_in_pane && !s.focused) {
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
    // Return UUID (id) for socket API, not ref
    if (this.claudeSurfaces.length === 1) return this.claudeSurfaces[0].id;
    const envSurface = this.claudeSurfaces.find(s => s.ref === `surface:${this.surfaceId}`);
    if (envSurface) return envSurface.id;
    return this.claudeSurfaces[0]?.id || null;
  }

  // ── Send to Terminal (via direct socket) ───────

  async sendToSurface(surfaceId, text) {
    if (!this.available || !surfaceId) return false;
    try {
      await this.socketCall("surface.send_text", {
        surface_id: surfaceId,
        text,
      });
      return true;
    } catch (e) {
      console.error(`  cmux: sendToSurface failed — ${e.message}`);
      return false;
    }
  }

  async sendToClaudeCode(text) {
    const target = this.getDefaultClaudeSurface();
    if (!target) return false;
    return this.sendToSurface(target, text + "\n");
  }

  // ── Sidebar Status ─────────────────────────────

  async setStatus(key, value, opts = {}) {
    if (!this.available) return;
    const args = ["set-status", key, value, "--workspace", this.workspaceId];
    if (opts.icon) args.push("--icon", opts.icon);
    if (opts.color) args.push("--color", opts.color);
    try { await this.exec(args); } catch (e) { console.error(`  cmux: setStatus failed — ${e.message}`); }
  }

  async clearStatus(key) {
    if (!this.available) return;
    try { await this.exec(["clear-status", key, "--workspace", this.workspaceId]); } catch (e) { console.error(`  cmux: clearStatus failed — ${e.message}`); }
  }

  async setProgress(value, label) {
    if (!this.available) return;
    const args = ["set-progress", String(value), "--workspace", this.workspaceId];
    if (label) args.push("--label", label);
    try { await this.exec(args); } catch (e) { console.error(`  cmux: setProgress failed — ${e.message}`); }
  }

  async clearProgress() {
    if (!this.available) return;
    try { await this.exec(["clear-progress", "--workspace", this.workspaceId]); } catch (e) { console.error(`  cmux: clearProgress failed — ${e.message}`); }
  }

  // ── Logging & Notifications ────────────────────

  async log(level, source, message) {
    if (!this.available) return;
    try {
      await this.socketCall("notification.create", {
        workspace: this.workspaceId,
        title: `[${source}] ${message}`,
        level,
      });
    } catch {
      // Fallback to CLI
      try { await this.exec(["log", "--level", level, "--source", source, "--workspace", this.workspaceId, "--", message]); } catch {}
    }
  }

  async notify(title, body, subtitle) {
    if (!this.available) return;
    try {
      await this.socketCall("notification.create", {
        workspace: this.workspaceId,
        title,
        body: body || "",
        subtitle: subtitle || "",
      });
    } catch {
      const args = ["notify", "--title", title, "--workspace", this.workspaceId];
      if (subtitle) args.push("--subtitle", subtitle);
      if (body) args.push("--body", body);
      try { await this.exec(args); } catch {}
    }
  }

  // ── Browser Pane ───────────────────────────────

  async openBrowserPane(url) {
    if (!this.available) return false;
    try {
      await this.socketCall("pane.create", {
        workspace: this.workspaceId,
        type: "browser",
        url,
      });
      return true;
    } catch {
      return false;
    }
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
