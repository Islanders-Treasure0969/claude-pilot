/**
 * cmux Bridge — Encapsulates all cmux CLI interactions for Claude Pilot.
 * Falls back gracefully when cmux is not available.
 */

import { execFile } from "child_process";

const EXEC_TIMEOUT = 5000;
const CMUX_BIN = process.env.CMUX_BIN || "/Applications/cmux.app/Contents/Resources/bin/cmux";

export class CmuxBridge {
  constructor() {
    this.workspaceId = process.env.CMUX_WORKSPACE_ID || null;
    this.surfaceId = process.env.CMUX_SURFACE_ID || null;
    this.claudePid = process.env.CMUX_CLAUDE_PID || null;
    this.socketPath = process.env.CMUX_SOCKET_PATH || null;
    this.available = !!this.workspaceId;
    this.claudeSurfaces = [];

    this.ready = this.available ? this._init().catch(() => { this.available = false; }) : Promise.resolve();
  }

  async _init() {
    try {
      await this.exec(["ping"]);
    } catch {
      this.available = false;
      return;
    }
    await this.refreshClaudeSurfaces();
  }

  exec(args) {
    // Build args with socket path if available
    const fullArgs = this.socketPath ? ["--socket", this.socketPath, ...args] : args;
    return new Promise((resolve, reject) => {
      execFile(CMUX_BIN, fullArgs, { timeout: EXEC_TIMEOUT }, (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout.trim());
      });
    });
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
        // Match all terminal surfaces
        const termMatch = line.match(/(surface:\d+)\s+\[terminal\]\s+"([^"]*)"/);
        if (!termMatch) continue;
        const ref = termMatch[1];
        const title = termMatch[2];
        allTerminals.push({ ref, title });

        // Priority 1: title starts with or contains "Claude Code" or "claude>" (not path containing "claude")
        if (/\bclaude\s*(code|>|\|)/i.test(title) || /^claude\b/i.test(title)) claudeMatches.push({ ref, title });
        // Priority 2: line contains "here" marker (current Claude Code session)
        if (/here/.test(line)) hereMatches.push({ ref, title });
      }

      // Use best available match
      if (claudeMatches.length > 0) {
        this.claudeSurfaces = claudeMatches;
      } else if (hereMatches.length > 0) {
        this.claudeSurfaces = hereMatches;
      } else {
        // Filter out known non-Claude surfaces (Yazi, etc)
        const filtered = allTerminals.filter(s => !/^Yazi:|^vim:|^nvim:/i.test(s.title));
        this.claudeSurfaces = filtered;
      }
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
    } catch {
      return false;
    }
  }

  async sendKey(surfaceRef, key) {
    if (!this.available || !surfaceRef) return false;
    try {
      await this.exec(["send-key", "--surface", surfaceRef, key]);
      return true;
    } catch {
      return false;
    }
  }

  async sendToClaudeCode(text, surfaceRef) {
    const target = surfaceRef || this.getDefaultClaudeSurface();
    if (!target) {
      console.error("  cmux: No Claude Code surface found. Ensure the server runs in a cmux foreground pane.");
      return false;
    }
    const sent = await this.sendToSurface(target, text);
    if (!sent) {
      console.error(`  cmux: Failed to send to ${target}. The server must run in a cmux foreground pane (not background).`);
      return false;
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
