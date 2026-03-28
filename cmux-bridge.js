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
      const timeout = setTimeout(() => {
        sock.destroy();
        reject(new Error(`Timeout: ${method}`));
      }, SOCKET_TIMEOUT);

      sock.on("connect", () => {
        const msg = JSON.stringify({ method, params });
        sock.write(msg + "\n");
      });

      sock.on("data", (chunk) => {
        responseData += chunk.toString();
        // Try to parse complete JSON response
        try {
          const parsed = JSON.parse(responseData);
          clearTimeout(timeout);
          sock.end();
          if (parsed.ok) resolve(parsed.result || {});
          else reject(new Error(parsed.error || `${method} failed`));
        } catch {
          // Incomplete data, wait for more
        }
      });

      sock.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      sock.on("close", () => {
        clearTimeout(timeout);
        if (responseData) {
          try {
            const parsed = JSON.parse(responseData);
            if (parsed.ok) resolve(parsed.result || {});
            else reject(new Error(parsed.error || `${method} failed`));
          } catch {
            reject(new Error(`Invalid response from ${method}`));
          }
        }
      });
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
      const surfaces = (result.surfaces || []).filter(s => s.type === "terminal");
      const claudeMatches = [];
      const hereMatches = [];

      for (const s of surfaces) {
        const ref = `surface:${s.index}`;
        const title = s.title || "";
        if (/\bclaude\s*(code|>|\|)/i.test(title) || /^claude\b/i.test(title)) {
          claudeMatches.push({ ref, title });
        }
        if (s.is_caller || s.is_focused) {
          hereMatches.push({ ref, title });
        }
      }

      if (claudeMatches.length > 0) this.claudeSurfaces = claudeMatches;
      else if (hereMatches.length > 0) this.claudeSurfaces = hereMatches;
      else {
        this.claudeSurfaces = surfaces
          .filter(s => !/^Yazi:|^vim:|^nvim:/i.test(s.title || ""))
          .map(s => ({ ref: `surface:${s.index}`, title: s.title || "" }));
      }
      return this.claudeSurfaces;
    } catch {
      // Fallback to CLI tree parsing if socket call fails
      try {
        const tree = await this.exec(["tree", "--workspace", this.workspaceId]);
        const allTerminals = [];
        const hereMatches = [];
        for (const line of tree.split("\n")) {
          const termMatch = line.match(/(surface:\d+)\s+\[terminal\]\s+"([^"]*)"/);
          if (!termMatch) continue;
          allTerminals.push({ ref: termMatch[1], title: termMatch[2] });
          if (/here/.test(line)) hereMatches.push({ ref: termMatch[1], title: termMatch[2] });
        }
        this.claudeSurfaces = hereMatches.length > 0 ? hereMatches :
          allTerminals.filter(s => !/^Yazi:|^vim:|^nvim:/i.test(s.title));
      } catch {}
      return this.claudeSurfaces;
    }
  }

  getDefaultClaudeSurface() {
    if (this.claudeSurfaces.length === 1) return this.claudeSurfaces[0].ref;
    const envSurface = this.claudeSurfaces.find(s => s.ref === `surface:${this.surfaceId}`);
    if (envSurface) return envSurface.ref;
    return this.claudeSurfaces[0]?.ref || null;
  }

  // ── Send to Terminal (via direct socket) ───────

  async sendToSurface(surfaceRef, text) {
    if (!this.available || !surfaceRef) return false;
    try {
      await this.socketCall("surface.send_text", {
        surface: surfaceRef,
        text,
      });
      return true;
    } catch (e) {
      console.error(`  cmux: sendToSurface failed — ${e.message}`);
      return false;
    }
  }

  async sendKey(surfaceRef, key) {
    if (!this.available || !surfaceRef) return false;
    try {
      await this.socketCall("surface.send_key", {
        surface: surfaceRef,
        key,
      });
      return true;
    } catch (e) {
      console.error(`  cmux: sendKey failed — ${e.message}`);
      return false;
    }
  }

  async sendToClaudeCode(text, surfaceRef) {
    const target = surfaceRef || this.getDefaultClaudeSurface();
    if (!target) return false;
    // Use \n in text to send Enter, avoiding separate sendKey call
    const sent = await this.sendToSurface(target, text + "\n");
    return sent;
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
